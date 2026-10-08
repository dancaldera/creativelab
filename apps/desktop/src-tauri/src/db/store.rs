//! `rusqlite` store — the Rust mirror of `packages/core/src/store/sqlite-store.ts`.
//!
//! ## Save strategy (identical to the TypeScript store)
//! `save_document` replaces the timeline tables (`sequences`/`tracks`/`clips`/`effects`/
//! `keyframes`) wholesale inside one transaction. Assets are **upserted, never deleted**,
//! because a background generation job or the media prober may write an asset while the
//! in-memory document is stale. Removal is explicit (`delete_asset`).
//!
//! ## Why the SQL is spelled out rather than generated
//! The TypeScript store and this one write the same database file. Every column list and
//! every `ON CONFLICT` clause here is transcribed from `sqlite-store.ts` so that a
//! document written by one is read identically by the other.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::migrate::now_iso8601;
use crate::error::{CommandError, CommandResult};
use crate::protocol::*;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

fn text(row: &Row<'_>, index: usize) -> CommandResult<String> {
    Ok(row.get::<_, Option<String>>(index)?.unwrap_or_default())
}

fn text_opt(row: &Row<'_>, index: usize) -> CommandResult<Option<String>> {
    Ok(row.get::<_, Option<String>>(index)?)
}

fn int(row: &Row<'_>, index: usize) -> CommandResult<i64> {
    Ok(row.get::<_, Option<i64>>(index)?.unwrap_or(0))
}

fn int_opt(row: &Row<'_>, index: usize) -> CommandResult<Option<i64>> {
    Ok(row.get::<_, Option<i64>>(index)?)
}

fn real(row: &Row<'_>, index: usize) -> CommandResult<f64> {
    Ok(row.get::<_, Option<f64>>(index)?.unwrap_or(0.0))
}

fn real_opt(row: &Row<'_>, index: usize) -> CommandResult<Option<f64>> {
    Ok(row.get::<_, Option<f64>>(index)?)
}

fn boolean(row: &Row<'_>, index: usize) -> CommandResult<bool> {
    Ok(int(row, index)? != 0)
}

fn json_value(raw: Option<String>, fallback: serde_json::Value) -> serde_json::Value {
    match raw {
        Some(text) => serde_json::from_str(&text).unwrap_or(fallback),
        None => fallback,
    }
}

fn encode_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// The single project row a workspace database holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
    pub id: String,
    pub title: String,
    pub schema_version: i64,
    pub workspace_rel_path: String,
    pub updated_at: String,
}

/// Look up the project row. Mirrors `#requireProjectId` in the TS store.
pub fn project_ref(connection: &Connection) -> CommandResult<ProjectRef> {
    let row = connection
        .query_row(
            "SELECT id, title, schema_version, workspace_rel_path, updated_at FROM projects \
             ORDER BY created_at ASC LIMIT 1",
            [],
            |row| {
                Ok(ProjectRef {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    schema_version: row.get(2)?,
                    workspace_rel_path: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?;
    row.ok_or_else(|| {
        CommandError::configuration("this workspace has no project; create or open one first")
    })
}

// ---------------------------------------------------------------------------
// Document load / save
// ---------------------------------------------------------------------------

fn map_asset(row: &Row<'_>) -> CommandResult<AssetDto> {
    let fps_num = int_opt(row, 14)?;
    let fps_den = int_opt(row, 15)?;
    Ok(AssetDto {
        id: text(row, 0)?,
        project_id: text(row, 1)?,
        media_type: text(row, 2)?,
        storage_mode: text(row, 3)?,
        uri: text(row, 4)?,
        relative_path: text_opt(row, 5)?,
        sha256: text_opt(row, 6)?,
        bytes: int_opt(row, 7)?,
        duration_frames: int_opt(row, 8)?,
        width: int_opt(row, 9)?,
        height: int_opt(row, 10)?,
        sample_rate: int_opt(row, 11)?,
        channels: int_opt(row, 12)?,
        fps: match (fps_num, fps_den) {
            (Some(num), Some(den)) => Some(FrameRateDto::new(num, den)),
            _ => None,
        },
        codec: text_opt(row, 16)?,
        container: text_opt(row, 17)?,
        origin: text(row, 18)?,
        parent_asset_id: text_opt(row, 19)?,
        generation_job_id: text_opt(row, 20)?,
        prompt_revision_id: text_opt(row, 21)?,
        probe: Some(json_value(text_opt(row, 22)?, serde_json::Value::Null)),
        missing_at: text_opt(row, 23)?,
        created_at: text(row, 24)?,
        updated_at: text(row, 25)?,
    })
}

const ASSET_COLUMNS: &str =
    "id, project_id, media_type, storage_mode, uri, relative_path, sha256, bytes, \
     duration_frames, width, height, sample_rate, channels, fps_num, fps_den, codec, container, \
     origin, parent_asset_id, generation_job_id, prompt_revision_id, probe_json, missing_at, \
     created_at, updated_at";

pub fn load_document(connection: &Connection) -> CommandResult<DocumentDto> {
    let project_id = project_ref(connection)?.id;

    let project = connection.query_row(
        "SELECT id, schema_version, title, fps_num, fps_den, width, height, color_profile, \
                sample_rate, channels, workspace_rel_path, created_at, updated_at \
         FROM projects WHERE id = ?",
        [&project_id],
        |row| {
            row_map(row, |row| {
                Ok(ProjectDto {
                    id: text(row, 0)?,
                    schema_version: int(row, 1)?,
                    title: text(row, 2)?,
                    fps: FrameRateDto::new(int(row, 3)?, int(row, 4)?),
                    width: int(row, 5)?,
                    height: int(row, 6)?,
                    color_profile: text(row, 7)?,
                    sample_rate: int(row, 8)?,
                    channels: int(row, 9)?,
                    workspace_rel_path: text(row, 10)?,
                    created_at: text(row, 11)?,
                    updated_at: text(row, 12)?,
                })
            })
        },
    )??;

    let sequences = collect(
        connection,
        "SELECT id, project_id, name, width, height, fps_num, fps_den, duration_frames, is_active, \
                created_at, updated_at \
         FROM sequences WHERE project_id = ? ORDER BY created_at ASC",
        [&project_id],
        |row| {
            Ok(SequenceDto {
                id: text(row, 0)?,
                project_id: text(row, 1)?,
                name: text(row, 2)?,
                width: int(row, 3)?,
                height: int(row, 4)?,
                fps: FrameRateDto::new(int(row, 5)?, int(row, 6)?),
                duration_frames: int(row, 7)?,
                is_active: boolean(row, 8)?,
                created_at: text(row, 9)?,
                updated_at: text(row, 10)?,
            })
        },
    )?;

    let tracks = collect(
        connection,
        "SELECT id, sequence_id, kind, name, sort_order, muted, locked, hidden, solo, volume_db, \
                created_at, updated_at \
         FROM tracks WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) \
         ORDER BY sort_order ASC",
        [&project_id],
        |row| {
            Ok(TrackDto {
                id: text(row, 0)?,
                sequence_id: text(row, 1)?,
                kind: text(row, 2)?,
                name: text(row, 3)?,
                sort_order: int(row, 4)?,
                muted: boolean(row, 5)?,
                locked: boolean(row, 6)?,
                hidden: boolean(row, 7)?,
                solo: boolean(row, 8)?,
                volume_db: real(row, 9)?,
                created_at: text(row, 10)?,
                updated_at: text(row, 11)?,
            })
        },
    )?;

    let clips = collect(
        connection,
        "SELECT id, track_id, sequence_id, asset_id, label, start_frame, source_in_frame, \
                duration_frames, speed_num, speed_den, properties_json, version, created_at, updated_at \
         FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) \
         ORDER BY start_frame ASC",
        [&project_id],
        |row| {
            let mut properties = json_value(text_opt(row, 10)?, serde_json::json!({}));
            // `speed_num`/`speed_den` are the queryable mirror of `properties.speed`; the
            // JSON column is canonical, so seed it from the columns when absent — exactly
            // what `sqlite-store.ts` does.
            let has_speed = properties
                .as_object()
                .map(|object| object.contains_key("speed"))
                .unwrap_or(false);
            if !has_speed {
                let num = int(row, 8)?;
                let den = int(row, 9)?;
                if let Some(object) = properties.as_object_mut() {
                    object.insert(
                        "speed".to_string(),
                        serde_json::json!({
                            "num": if num > 0 { num } else { 1 },
                            "den": if den > 0 { den } else { 1 },
                        }),
                    );
                }
            }
            Ok(ClipDto {
                id: text(row, 0)?,
                track_id: text(row, 1)?,
                sequence_id: text(row, 2)?,
                asset_id: text_opt(row, 3)?,
                label: text(row, 4)?,
                start_frame: int(row, 5)?,
                source_in_frame: int(row, 6)?,
                duration_frames: int(row, 7)?,
                properties,
                version: int(row, 11)?,
                created_at: text(row, 12)?,
                updated_at: text(row, 13)?,
            })
        },
    )?;

    let effects = collect(
        connection,
        "SELECT e.id, e.clip_id, e.kind, e.sort_order, e.enabled, e.params_json, e.created_at, e.updated_at \
         FROM effects e JOIN clips c ON c.id = e.clip_id \
         WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY e.sort_order ASC",
        [&project_id],
        |row| {
            Ok(EffectDto {
                id: text(row, 0)?,
                clip_id: text(row, 1)?,
                kind: text(row, 2)?,
                sort_order: int(row, 3)?,
                enabled: boolean(row, 4)?,
                params: json_value(text_opt(row, 5)?, serde_json::json!({})),
                created_at: text(row, 6)?,
                updated_at: text(row, 7)?,
            })
        },
    )?;

    let keyframes = collect(
        connection,
        "SELECT k.id, k.effect_id, k.property, k.frame, k.value_json, k.easing, k.created_at \
         FROM keyframes k JOIN effects e ON e.id = k.effect_id JOIN clips c ON c.id = e.clip_id \
         WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY k.frame ASC",
        [&project_id],
        |row| {
            Ok(KeyframeDto {
                id: text(row, 0)?,
                effect_id: text(row, 1)?,
                property: text(row, 2)?,
                frame: int(row, 3)?,
                value: json_value(text_opt(row, 4)?, serde_json::json!(0)),
                easing: text(row, 5)?,
                created_at: text(row, 6)?,
            })
        },
    )?;

    let assets = collect(
        connection,
        &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ? ORDER BY created_at ASC"),
        [&project_id],
        map_asset,
    )?;

    Ok(DocumentDto {
        project,
        sequences,
        tracks,
        clips,
        effects,
        keyframes,
        assets,
    })
}

/// Small helper so each `SELECT` above stays a single expression.
/// Adapt a row mapper that returns [`CommandResult`] to the `rusqlite::Result` shape
/// `query_map` requires, preserving the original error through the `rusqlite` error chain.
fn row_map<T>(
    row: &Row<'_>,
    map: impl FnOnce(&Row<'_>) -> CommandResult<T>,
) -> rusqlite::Result<CommandResult<T>> {
    Ok(map(row))
}

fn collect<P, T>(
    connection: &Connection,
    sql: &str,
    params: P,
    map: impl Fn(&Row<'_>) -> CommandResult<T>,
) -> CommandResult<Vec<T>>
where
    P: rusqlite::Params,
{
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| row_map(row, &map))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

/// Create the project row plus the default timeline (1 sequence, 3 video / 4 audio /
/// 1 caption track) — matching `createInitialDocument` in core.
pub fn create_project(
    connection: &mut Connection,
    project: &ProjectDto,
) -> CommandResult<DocumentDto> {
    let now = now_iso8601();
    let made_at = if project.created_at.is_empty() {
        now.clone()
    } else {
        project.created_at.clone()
    };
    let sequence_id = format!("seq_{}", uuid::Uuid::new_v4().simple());
    let mut document = DocumentDto {
        project: ProjectDto {
            created_at: made_at.clone(),
            updated_at: now.clone(),
            ..project.clone()
        },
        sequences: vec![SequenceDto {
            id: sequence_id.clone(),
            project_id: project.id.clone(),
            name: "Main".to_string(),
            width: project.width,
            height: project.height,
            fps: project.fps,
            duration_frames: 0,
            is_active: true,
            created_at: made_at.clone(),
            updated_at: made_at.clone(),
        }],
        tracks: Vec::new(),
        clips: Vec::new(),
        effects: Vec::new(),
        keyframes: Vec::new(),
        assets: Vec::new(),
    };
    for index in 0..3 {
        document
            .tracks
            .push(default_track(&sequence_id, "video", index, &made_at));
    }
    for index in 0..4 {
        document
            .tracks
            .push(default_track(&sequence_id, "audio", index, &made_at));
    }
    document
        .tracks
        .push(default_track(&sequence_id, "caption", 0, &made_at));

    connection.execute(
        "INSERT INTO projects (id, schema_version, title, fps_num, fps_den, width, height, \
                               color_profile, sample_rate, channels, workspace_rel_path, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            document.project.id,
            document.project.schema_version,
            document.project.title,
            document.project.fps.num,
            document.project.fps.den,
            document.project.width,
            document.project.height,
            document.project.color_profile,
            document.project.sample_rate,
            document.project.channels,
            document.project.workspace_rel_path,
            document.project.created_at,
            document.project.updated_at,
        ],
    )?;
    write_timeline(connection, &document, &now)?;
    Ok(document)
}

fn default_track(sequence_id: &str, kind: &str, index: i64, now: &str) -> TrackDto {
    let prefix = match kind {
        "video" => "V",
        "audio" => "A",
        _ => "C",
    };
    TrackDto {
        id: format!("trk_{}", uuid::Uuid::new_v4().simple()),
        sequence_id: sequence_id.to_string(),
        kind: kind.to_string(),
        name: format!("{prefix}{}", index + 1),
        sort_order: index,
        muted: false,
        locked: false,
        hidden: false,
        solo: false,
        volume_db: 0.0,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

/// Transactional replace of the timeline tables plus an asset upsert pass.
pub fn save_document(
    connection: &mut Connection,
    document: &DocumentDto,
) -> CommandResult<ProjectSaveResponse> {
    let now = now_iso8601();
    let project_id = document.project.id.clone();
    let transaction = connection.transaction()?;

    let updated = transaction.execute(
        "UPDATE projects SET title = ?, fps_num = ?, fps_den = ?, width = ?, height = ?, color_profile = ?, \
                             sample_rate = ?, channels = ?, schema_version = ?, updated_at = ? \
         WHERE id = ?",
        params![
            document.project.title,
            document.project.fps.num,
            document.project.fps.den,
            document.project.width,
            document.project.height,
            document.project.color_profile,
            document.project.sample_rate,
            document.project.channels,
            document.project.schema_version,
            now,
            project_id,
        ],
    )?;
    if updated == 0 {
        return Err(CommandError::configuration(format!(
            "no project row for {project_id} in this workspace"
        )));
    }

    write_timeline(&transaction, document, &now)?;
    transaction.commit()?;

    Ok(ProjectSaveResponse {
        saved_at: now,
        schema_version: document.project.schema_version,
        clips: document.clips.len() as i64,
        tracks: document.tracks.len() as i64,
    })
}

/// Replace timeline rows for this project. Order matters: `effects` and `keyframes`
/// cascade from `clips`, and `clips` cascade from `tracks`.
fn write_timeline(connection: &Connection, document: &DocumentDto, now: &str) -> CommandResult<()> {
    let project_id = &document.project.id;
    let sequence_ids: Vec<&str> = document
        .sequences
        .iter()
        .map(|sequence| sequence.id.as_str())
        .collect();

    connection.execute(
        "DELETE FROM keyframes WHERE effect_id IN (
           SELECT e.id FROM effects e JOIN clips c ON c.id = e.clip_id
           WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?))",
        [project_id],
    )?;
    connection.execute(
        "DELETE FROM effects WHERE clip_id IN (
           SELECT id FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?))",
        [project_id],
    )?;
    connection.execute(
        "DELETE FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?)",
        [project_id],
    )?;
    connection.execute(
        "DELETE FROM tracks WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?)",
        [project_id],
    )?;
    // Safe to replace sequences wholesale: `export_jobs.sequence_id` is an audit
    // reference without a foreign key, so render history survives.
    connection.execute("DELETE FROM sequences WHERE project_id = ?", [project_id])?;

    for sequence in &document.sequences {
        connection.execute(
            "INSERT INTO sequences (id, project_id, name, width, height, fps_num, fps_den, duration_frames, \
                                    is_active, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                sequence.id,
                project_id,
                sequence.name,
                sequence.width,
                sequence.height,
                sequence.fps.num,
                sequence.fps.den,
                sequence.duration_frames,
                if sequence.is_active { 1 } else { 0 },
                sequence.created_at,
                now,
            ],
        )?;
    }

    for track in &document.tracks {
        if !sequence_ids.contains(&track.sequence_id.as_str()) {
            continue;
        }
        connection.execute(
            "INSERT INTO tracks (id, sequence_id, kind, name, sort_order, muted, locked, hidden, solo, volume_db, \
                                 created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                track.id,
                track.sequence_id,
                track.kind,
                track.name,
                track.sort_order,
                if track.muted { 1 } else { 0 },
                if track.locked { 1 } else { 0 },
                if track.hidden { 1 } else { 0 },
                if track.solo { 1 } else { 0 },
                track.volume_db,
                track.created_at,
                now,
            ],
        )?;
    }

    for clip in &document.clips {
        if !sequence_ids.contains(&clip.sequence_id.as_str()) {
            continue;
        }
        let (speed_num, speed_den) = clip_speed(clip);
        connection.execute(
            "INSERT INTO clips (id, track_id, sequence_id, asset_id, label, start_frame, source_in_frame, \
                                duration_frames, speed_num, speed_den, properties_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                clip.id,
                clip.track_id,
                clip.sequence_id,
                clip.asset_id,
                clip.label,
                clip.start_frame,
                clip.source_in_frame,
                clip.duration_frames,
                speed_num,
                speed_den,
                encode_json(&clip.properties),
                clip.version,
                clip.created_at,
                now,
            ],
        )?;
    }

    for effect in &document.effects {
        connection.execute(
            "INSERT INTO effects (id, clip_id, kind, sort_order, enabled, params_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                effect.id,
                effect.clip_id,
                effect.kind,
                effect.sort_order,
                if effect.enabled { 1 } else { 0 },
                encode_json(&effect.params),
                effect.created_at,
                now,
            ],
        )?;
    }

    for keyframe in &document.keyframes {
        connection.execute(
            "INSERT INTO keyframes (id, effect_id, property, frame, value_json, easing, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                keyframe.id,
                keyframe.effect_id,
                keyframe.property,
                keyframe.frame,
                encode_json(&keyframe.value),
                keyframe.easing,
                keyframe.created_at,
            ],
        )?;
    }

    // Assets are upserted so a stale in-memory document can never delete media a
    // background generation job just committed.
    for asset in &document.assets {
        upsert_asset_at(connection, asset, now)?;
    }

    Ok(())
}

/// `properties.speed` is canonical; the columns mirror it for querying.
pub fn clip_speed(clip: &ClipDto) -> (i64, i64) {
    let speed = clip.properties.get("speed");
    let num = speed
        .and_then(|value| value.get("num"))
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let den = speed
        .and_then(|value| value.get("den"))
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    (num, den)
}

fn upsert_asset_at(connection: &Connection, asset: &AssetDto, now: &str) -> CommandResult<()> {
    connection.execute(
        "INSERT INTO assets (id, project_id, media_type, storage_mode, uri, relative_path, sha256, bytes, \
                             duration_frames, width, height, sample_rate, channels, fps_num, fps_den, codec, \
                             container, origin, parent_asset_id, generation_job_id, prompt_revision_id, \
                             probe_json, created_at, updated_at, missing_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           media_type = excluded.media_type, storage_mode = excluded.storage_mode, uri = excluded.uri, \
           relative_path = excluded.relative_path, sha256 = excluded.sha256, bytes = excluded.bytes, \
           duration_frames = excluded.duration_frames, width = excluded.width, height = excluded.height, \
           sample_rate = excluded.sample_rate, channels = excluded.channels, fps_num = excluded.fps_num, \
           fps_den = excluded.fps_den, codec = excluded.codec, container = excluded.container, \
           origin = excluded.origin, parent_asset_id = excluded.parent_asset_id, \
           generation_job_id = excluded.generation_job_id, prompt_revision_id = excluded.prompt_revision_id, \
           probe_json = excluded.probe_json, updated_at = excluded.updated_at, missing_at = excluded.missing_at",
        params![
            asset.id,
            asset.project_id,
            asset.media_type,
            asset.storage_mode,
            asset.uri,
            asset.relative_path,
            asset.sha256,
            asset.bytes,
            asset.duration_frames,
            asset.width,
            asset.height,
            asset.sample_rate,
            asset.channels,
            asset.fps.map(|fps| fps.num),
            asset.fps.map(|fps| fps.den),
            asset.codec,
            asset.container,
            asset.origin,
            asset.parent_asset_id,
            asset.generation_job_id,
            asset.prompt_revision_id,
            asset.probe.as_ref().map(encode_json),
            asset.created_at,
            now,
            asset.missing_at,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

pub fn insert_asset(connection: &Connection, asset: &AssetDto) -> CommandResult<()> {
    upsert_asset_at(connection, asset, &now_iso8601())
}

/// Merge `patch` onto the stored asset, mirroring `updateAsset`.
pub fn update_asset(
    connection: &Connection,
    asset_id: &str,
    patch: &serde_json::Value,
) -> CommandResult<AssetDto> {
    let existing = find_asset(connection, asset_id)?
        .ok_or_else(|| CommandError::validation(format!("unknown asset {asset_id}")))?;
    let mut merged = serde_json::to_value(&existing)?;
    if let (Some(target), Some(object)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in object {
            target.insert(key.clone(), value.clone());
        }
    }
    let mut updated: AssetDto = serde_json::from_value(merged)?;
    updated.id = asset_id.to_string();
    updated.updated_at = now_iso8601();
    upsert_asset_at(connection, &updated, &updated.updated_at.clone())?;
    Ok(updated)
}

pub fn find_asset(connection: &Connection, asset_id: &str) -> CommandResult<Option<AssetDto>> {
    let sql = format!("SELECT {ASSET_COLUMNS} FROM assets WHERE id = ?");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query_map([asset_id], |row| row_map(row, map_asset))?;
    match rows.next() {
        Some(row) => Ok(Some(row??)),
        None => Ok(None),
    }
}

pub fn list_assets(connection: &Connection) -> CommandResult<Vec<AssetDto>> {
    let project_id = project_ref(connection)?.id;
    collect(
        connection,
        &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ? ORDER BY created_at ASC"),
        [&project_id],
        map_asset,
    )
}

pub fn find_asset_by_sha256(
    connection: &Connection,
    sha256: &str,
) -> CommandResult<Option<AssetDto>> {
    let project_id = project_ref(connection)?.id;
    let sql =
        format!("SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ? AND sha256 = ? LIMIT 1");
    let mut statement = connection.prepare(&sql)?;
    let mut rows =
        statement.query_map(params![project_id, sha256], |row| row_map(row, map_asset))?;
    match rows.next() {
        Some(row) => Ok(Some(row??)),
        None => Ok(None),
    }
}

pub fn delete_asset(connection: &Connection, asset_id: &str) -> CommandResult<()> {
    let removed = connection.execute("DELETE FROM assets WHERE id = ?", [asset_id])?;
    if removed == 0 {
        return Err(CommandError::validation(format!(
            "unknown asset {asset_id}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Generation jobs
// ---------------------------------------------------------------------------

const JOB_COLUMNS: &str = "id, project_id, provider_id, model_id, mode, modality, status, \
     idempotency_key, submission_lock, request_json, provider_job_id, retry_count, next_poll_at, \
     progress, cost_estimate_json, actual_cost_json, output_asset_ids_json, error_json, \
     submitted_at, completed_at, created_at, updated_at";

fn map_job(row: &Row<'_>) -> CommandResult<JobDto> {
    let estimate = json_value(text_opt(row, 14)?, serde_json::Value::Null);
    let actual = json_value(text_opt(row, 15)?, serde_json::Value::Null);
    let spend = |value: serde_json::Value| -> Option<SpendDto> {
        let object = value.as_object()?;
        Some(SpendDto {
            amount: object.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0),
            currency: object
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("USD")
                .to_string(),
        })
    };
    Ok(JobDto {
        id: text(row, 0)?,
        provider_id: text(row, 2)?,
        model_id: text(row, 3)?,
        mode: text(row, 4)?,
        modality: text(row, 5)?,
        status: text(row, 6)?,
        progress: real_opt(row, 13)?,
        provider_job_id: text_opt(row, 10)?,
        retry_count: int(row, 11)?,
        cost_estimate: spend(estimate),
        actual_cost: spend(actual),
        output_asset_ids: json_value(text_opt(row, 16)?, serde_json::json!([]))
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        error: {
            let value = json_value(text_opt(row, 17)?, serde_json::Value::Null);
            if value.is_null() {
                None
            } else {
                Some(value)
            }
        },
        created_at: text(row, 20)?,
        updated_at: text(row, 21)?,
    })
}

/// Insert a generation job from a raw request body. `request_json` and
/// `idempotency_key` stay Rust-side; the renderer only sees the `JobDto` projection.
pub fn insert_job(connection: &Connection, job: &serde_json::Value) -> CommandResult<JobDto> {
    let get_str = |key: &str| -> CommandResult<String> {
        job.get(key)
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| CommandError::validation(format!("job is missing '{key}'")))
    };
    let now = now_iso8601();
    let id = job
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("job_{}", uuid::Uuid::new_v4().simple()));
    let project_id = project_ref(connection)?.id;
    connection.execute(
        "INSERT INTO generation_jobs (id, project_id, provider_id, model_id, mode, modality, status, \
                                      idempotency_key, submission_lock, request_json, provider_job_id, \
                                      retry_count, next_poll_at, progress, cost_estimate_json, actual_cost_json, \
                                      output_asset_ids_json, error_json, submitted_at, completed_at, \
                                      created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            project_id,
            get_str("providerId")?,
            get_str("modelId")?,
            get_str("mode")?,
            get_str("modality")?,
            job.get("status").and_then(|v| v.as_str()).unwrap_or("queued"),
            job.get("idempotencyKey").and_then(|v| v.as_str()),
            job.get("submissionLock").and_then(|v| v.as_str()),
            job.get("request").map(encode_json).unwrap_or_else(|| "{}".into()),
            job.get("providerJobId").and_then(|v| v.as_str()),
            job.get("retryCount").and_then(|v| v.as_i64()).unwrap_or(0),
            job.get("nextPollAt").and_then(|v| v.as_str()),
            job.get("progress").and_then(|v| v.as_f64()),
            job.get("costEstimate").map(encode_json),
            job.get("actualCost").map(encode_json),
            job
                .get("outputAssetIds")
                .map(encode_json)
                .unwrap_or_else(|| "[]".into()),
            job.get("error").map(encode_json),
            job.get("submittedAt").and_then(|v| v.as_str()),
            job.get("completedAt").and_then(|v| v.as_str()),
            now,
            now,
        ],
    )?;
    find_job(connection, &id)?.ok_or_else(|| CommandError::internal("job insert did not persist"))
}

pub fn find_job(connection: &Connection, job_id: &str) -> CommandResult<Option<JobDto>> {
    let sql = format!("SELECT {JOB_COLUMNS} FROM generation_jobs WHERE id = ?");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query_map([job_id], |row| row_map(row, map_job))?;
    match rows.next() {
        Some(row) => Ok(Some(row??)),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, Default)]
pub struct JobUpdate {
    pub status: Option<String>,
    pub progress: Option<f64>,
    pub provider_job_id: Option<String>,
    pub submission_lock: Option<String>,
    pub retry_count: Option<i64>,
    pub next_poll_at: Option<String>,
    pub cost_estimate: Option<serde_json::Value>,
    pub actual_cost: Option<serde_json::Value>,
    pub output_asset_ids: Option<Vec<String>>,
    pub error: Option<serde_json::Value>,
    pub submitted_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct JobEvent {
    pub from_state: Option<String>,
    pub to_state: String,
    pub detail: Option<serde_json::Value>,
}

/// Update a job and, when `event` is supplied, append the matching `job_events` row
/// inside the same transaction so the audit trail can never disagree with the state.
pub fn update_job(
    connection: &mut Connection,
    job_id: &str,
    update: &JobUpdate,
    event: Option<JobEvent>,
) -> CommandResult<JobDto> {
    let now = now_iso8601();
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE generation_jobs SET \
           status = COALESCE(?, status), progress = COALESCE(?, progress), \
           provider_job_id = COALESCE(?, provider_job_id), submission_lock = COALESCE(?, submission_lock), \
           retry_count = COALESCE(?, retry_count), next_poll_at = COALESCE(?, next_poll_at), \
           cost_estimate_json = COALESCE(?, cost_estimate_json), actual_cost_json = COALESCE(?, actual_cost_json), \
           output_asset_ids_json = COALESCE(?, output_asset_ids_json), error_json = COALESCE(?, error_json), \
           submitted_at = COALESCE(?, submitted_at), completed_at = COALESCE(?, completed_at), updated_at = ? \
         WHERE id = ?",
        params![
            update.status,
            update.progress,
            update.provider_job_id,
            update.submission_lock,
            update.retry_count,
            update.next_poll_at,
            update.cost_estimate.as_ref().map(encode_json),
            update.actual_cost.as_ref().map(encode_json),
            update
                .output_asset_ids
                .as_ref()
                .map(|ids| encode_json(&serde_json::json!(ids))),
            update.error.as_ref().map(encode_json),
            update.submitted_at,
            update.completed_at,
            now,
            job_id,
        ],
    )?;
    if changed == 0 {
        return Err(CommandError::validation(format!("unknown job {job_id}")));
    }
    if let Some(event) = event {
        transaction.execute(
            "INSERT INTO job_events (id, job_id, from_state, to_state, detail_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                format!("evt_{}", uuid::Uuid::new_v4().simple()),
                job_id,
                event.from_state,
                event.to_state,
                event.detail.as_ref().map(encode_json),
                now,
            ],
        )?;
    }
    transaction.commit()?;
    find_job(connection, job_id)?
        .ok_or_else(|| CommandError::internal("job disappeared after update"))
}

pub fn list_jobs(
    connection: &Connection,
    statuses: Option<&[String]>,
    limit: Option<i64>,
) -> CommandResult<Vec<JobDto>> {
    let project_id = project_ref(connection)?.id;
    let mut clauses = vec!["project_id = ?".to_string()];
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(project_id)];
    if let Some(statuses) = statuses {
        if !statuses.is_empty() {
            let placeholders = vec!["?"; statuses.len()].join(", ");
            clauses.push(format!("status IN ({placeholders})"));
            for status in statuses {
                values.push(Box::new(status.clone()));
            }
        }
    }
    values.push(Box::new(limit.unwrap_or(500)));
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM generation_jobs WHERE {} ORDER BY created_at DESC LIMIT ?",
        clauses.join(" AND ")
    );
    let borrowed: Vec<&dyn rusqlite::ToSql> = values.iter().map(|value| value.as_ref()).collect();
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(borrowed.as_slice(), |row| row_map(row, map_job))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

/// Jobs left non-terminal by a previous run, plus everything needed to reconcile.
pub fn list_unfinished_jobs(connection: &Connection) -> CommandResult<Vec<JobDto>> {
    let project_id = project_ref(connection)?.id;
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM generation_jobs \
         WHERE project_id = ? AND status NOT IN ('completed', 'failed', 'canceled') \
         ORDER BY created_at ASC"
    );
    collect(connection, &sql, [&project_id], map_job)
}

// ---------------------------------------------------------------------------
// Export jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ExportJobRow {
    pub id: String,
    pub project_id: String,
    pub sequence_id: String,
    pub preset: serde_json::Value,
    pub output_path: String,
    pub status: String,
    pub progress: f64,
    pub rendered_frames: i64,
    pub total_frames: i64,
    pub errors: Vec<String>,
    pub log_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn insert_export_job(connection: &Connection, job: &ExportJobRow) -> CommandResult<()> {
    connection.execute(
        "INSERT INTO export_jobs (id, project_id, sequence_id, preset_json, output_path, status, progress, \
                                  rendered_frames, total_frames, errors_json, log_path, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            job.id,
            job.project_id,
            job.sequence_id,
            encode_json(&job.preset),
            job.output_path,
            job.status,
            job.progress,
            job.rendered_frames,
            job.total_frames,
            encode_json(&serde_json::json!(job.errors)),
            job.log_path,
            job.created_at,
            job.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_export_job(connection: &Connection, job: &ExportJobRow) -> CommandResult<()> {
    let changed = connection.execute(
        "UPDATE export_jobs SET status = ?, progress = ?, rendered_frames = ?, total_frames = ?, \
                                errors_json = ?, log_path = ?, updated_at = ? \
         WHERE id = ?",
        params![
            job.status,
            job.progress,
            job.rendered_frames,
            job.total_frames,
            encode_json(&serde_json::json!(job.errors)),
            job.log_path,
            job.updated_at,
            job.id,
        ],
    )?;
    if changed == 0 {
        return Err(CommandError::validation(format!(
            "unknown export job {}",
            job.id
        )));
    }
    Ok(())
}

fn map_export_job(row: &Row<'_>) -> CommandResult<ExportJobRow> {
    Ok(ExportJobRow {
        id: text(row, 0)?,
        project_id: text(row, 1)?,
        sequence_id: text(row, 2)?,
        preset: json_value(text_opt(row, 3)?, serde_json::json!({})),
        output_path: text(row, 4)?,
        status: text(row, 5)?,
        progress: real(row, 6)?,
        rendered_frames: int(row, 7)?,
        total_frames: int(row, 8)?,
        errors: json_value(text_opt(row, 9)?, serde_json::json!([]))
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        log_path: text_opt(row, 10)?,
        created_at: text(row, 11)?,
        updated_at: text(row, 12)?,
    })
}

pub fn find_export_job(
    connection: &Connection,
    export_job_id: &str,
) -> CommandResult<Option<ExportJobRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, sequence_id, preset_json, output_path, status, progress, \
                rendered_frames, total_frames, errors_json, log_path, created_at, updated_at \
         FROM export_jobs WHERE id = ?",
    )?;
    let mut rows = statement.query_map([export_job_id], |row| row_map(row, map_export_job))?;
    match rows.next() {
        Some(row) => Ok(Some(row??)),
        None => Ok(None),
    }
}

pub fn list_export_jobs(connection: &Connection, limit: i64) -> CommandResult<Vec<ExportJobRow>> {
    let project_id = project_ref(connection)?.id;
    collect(
        connection,
        "SELECT id, project_id, sequence_id, preset_json, output_path, status, progress, \
                rendered_frames, total_frames, errors_json, log_path, created_at, updated_at \
         FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
        params![project_id, limit],
        map_export_job,
    )
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigRow {
    pub id: String,
    pub project_id: Option<String>,
    pub provider_id: String,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub credential_ref: Option<String>,
    pub auth_scheme: String,
    pub extra_headers: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

fn map_provider_config(row: &Row<'_>) -> CommandResult<ProviderConfigRow> {
    Ok(ProviderConfigRow {
        id: text(row, 0)?,
        project_id: text_opt(row, 1)?,
        provider_id: text(row, 2)?,
        enabled: boolean(row, 3)?,
        base_url: text_opt(row, 4)?,
        credential_ref: text_opt(row, 5)?,
        auth_scheme: text(row, 6)?,
        extra_headers: json_value(text_opt(row, 7)?, serde_json::json!({})),
        created_at: text(row, 8)?,
        updated_at: text(row, 9)?,
    })
}

pub fn upsert_provider_config(
    connection: &Connection,
    config: &ProviderConfigRow,
) -> CommandResult<ProviderConfigRow> {
    let now = now_iso8601();
    let project_id = match config.project_id.clone() {
        Some(project_id) => project_id,
        None => project_ref(connection)?.id,
    };
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM provider_configs WHERE provider_id = ? AND COALESCE(project_id, '') = COALESCE(?, '')",
            params![config.provider_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let id = existing.unwrap_or_else(|| {
        if config.id.is_empty() {
            format!("pcfg_{}", uuid::Uuid::new_v4().simple())
        } else {
            config.id.clone()
        }
    });
    let created_at: String = connection
        .query_row(
            "SELECT created_at FROM provider_configs WHERE id = ?",
            [&id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| now.clone());

    connection.execute(
        "INSERT INTO provider_configs (id, project_id, provider_id, enabled, base_url, credential_ref, \
                                       auth_scheme, extra_headers_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, base_url = excluded.base_url, \
           credential_ref = excluded.credential_ref, auth_scheme = excluded.auth_scheme, \
           extra_headers_json = excluded.extra_headers_json, updated_at = excluded.updated_at",
        params![
            id,
            project_id,
            config.provider_id,
            if config.enabled { 1 } else { 0 },
            config.base_url,
            config.credential_ref,
            config.auth_scheme,
            encode_json(&config.extra_headers),
            created_at,
            now,
        ],
    )?;
    Ok(ProviderConfigRow {
        id,
        project_id: Some(project_id),
        created_at,
        updated_at: now,
        ..config.clone()
    })
}

pub fn list_provider_configs(connection: &Connection) -> CommandResult<Vec<ProviderConfigRow>> {
    collect(
        connection,
        "SELECT id, project_id, provider_id, enabled, base_url, credential_ref, auth_scheme, \
                extra_headers_json, created_at, updated_at \
         FROM provider_configs ORDER BY provider_id ASC",
        [],
        map_provider_config,
    )
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

pub fn upsert_model_catalog(
    connection: &mut Connection,
    entries: &[ProviderModelDto],
) -> CommandResult<()> {
    let transaction = connection.transaction()?;
    for entry in entries {
        transaction.execute(
            "INSERT INTO model_catalog (id, provider_id, model_id, display_name, modality, capabilities_json, \
                                        pricing_json, fetched_at, is_stale) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(provider_id, model_id, modality) DO UPDATE SET \
               display_name = excluded.display_name, capabilities_json = excluded.capabilities_json, \
               pricing_json = excluded.pricing_json, fetched_at = excluded.fetched_at, \
               is_stale = excluded.is_stale",
            params![
                format!("cat_{}", uuid::Uuid::new_v4().simple()),
                entry.provider_id,
                entry.model_id,
                entry.display_name,
                entry.modality,
                encode_json(&entry.capabilities),
                entry.pricing.as_ref().map(encode_json),
                entry.fetched_at,
                if entry.is_stale { 1 } else { 0 },
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn list_model_catalog(
    connection: &Connection,
    provider_id: Option<&str>,
) -> CommandResult<Vec<ProviderModelDto>> {
    let map = |row: &Row<'_>| -> CommandResult<ProviderModelDto> {
        Ok(ProviderModelDto {
            provider_id: text(row, 0)?,
            model_id: text(row, 1)?,
            display_name: text(row, 2)?,
            modality: text(row, 3)?,
            capabilities: json_value(text_opt(row, 4)?, serde_json::json!({})),
            pricing: {
                let value = json_value(text_opt(row, 5)?, serde_json::Value::Null);
                if value.is_null() {
                    None
                } else {
                    Some(value)
                }
            },
            fetched_at: text(row, 6)?,
            is_stale: boolean(row, 7)?,
        })
    };
    let columns =
        "provider_id, model_id, display_name, modality, capabilities_json, pricing_json, \
                   fetched_at, is_stale";
    match provider_id {
        Some(provider_id) => collect(
            connection,
            &format!(
                "SELECT {columns} FROM model_catalog WHERE provider_id = ? ORDER BY model_id ASC"
            ),
            [provider_id],
            map,
        ),
        None => collect(
            connection,
            &format!("SELECT {columns} FROM model_catalog ORDER BY provider_id ASC, model_id ASC"),
            [],
            map,
        ),
    }
}

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendRow {
    pub id: String,
    pub project_id: Option<String>,
    pub job_id: Option<String>,
    pub provider_id: String,
    pub amount: f64,
    pub currency: String,
    /// `"estimate" | "actual"`.
    pub kind: String,
    pub day: String,
    pub created_at: String,
}

pub fn record_spend(connection: &Connection, entry: &SpendRow) -> CommandResult<()> {
    connection.execute(
        "INSERT INTO spend_ledger (id, project_id, job_id, provider_id, amount_json, kind, day, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            entry.id,
            entry.project_id,
            entry.job_id,
            entry.provider_id,
            encode_json(&serde_json::json!({
                "amount": entry.amount,
                "currency": entry.currency,
            })),
            entry.kind,
            entry.day,
            entry.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_spend(
    connection: &Connection,
    day: Option<&str>,
    limit: Option<i64>,
) -> CommandResult<Vec<SpendRow>> {
    let map = |row: &Row<'_>| -> CommandResult<SpendRow> {
        let amount = json_value(text_opt(row, 4)?, serde_json::json!({}));
        Ok(SpendRow {
            id: text(row, 0)?,
            project_id: text_opt(row, 1)?,
            job_id: text_opt(row, 2)?,
            provider_id: text(row, 3)?,
            amount: amount.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0),
            currency: amount
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("USD")
                .to_string(),
            kind: text(row, 5)?,
            day: text(row, 6)?,
            created_at: text(row, 7)?,
        })
    };
    let columns = "id, project_id, job_id, provider_id, amount_json, kind, day, created_at";
    match day {
        Some(day) => collect(
            connection,
            &format!("SELECT {columns} FROM spend_ledger WHERE day = ? ORDER BY created_at DESC"),
            [day],
            map,
        ),
        None => collect(
            connection,
            &format!("SELECT {columns} FROM spend_ledger ORDER BY created_at DESC LIMIT ?"),
            [limit.unwrap_or(1000)],
            map,
        ),
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn get_setting(connection: &Connection, key: &str) -> CommandResult<Option<serde_json::Value>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.map(|text| serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
}

pub fn set_setting(
    connection: &Connection,
    key: &str,
    value: &serde_json::Value,
) -> CommandResult<()> {
    connection.execute(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![key, encode_json(value), now_iso8601()],
    )?;
    Ok(())
}

pub fn all_settings(
    connection: &Connection,
) -> CommandResult<serde_json::Map<String, serde_json::Value>> {
    let mut statement = connection.prepare("SELECT key, value_json FROM app_settings")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = serde_json::Map::new();
    for row in rows {
        let (key, raw) = row?;
        out.insert(
            key,
            serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null),
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub mod test_support {
    use super::*;
    use crate::db::migrate::run_migrations;

    /// A migrated in-memory database with one project row.
    pub fn project_database() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        run_migrations(&mut connection).expect("migrations");
        let project = ProjectDto {
            id: "prj_test".into(),
            schema_version: 1,
            title: "Fixture".into(),
            fps: FrameRateDto::new(30, 1),
            width: 1920,
            height: 1080,
            color_profile: "bt709".into(),
            sample_rate: 48_000,
            channels: 2,
            workspace_rel_path: ".".into(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        create_project(&mut connection, &project).expect("create project");
        connection
    }

    pub fn fixture_asset(id: &str) -> AssetDto {
        AssetDto {
            id: id.into(),
            project_id: "prj_test".into(),
            media_type: "video".into(),
            storage_mode: "copied".into(),
            uri: format!("assets/originals/{id}.mp4"),
            relative_path: Some(format!("assets/originals/{id}.mp4")),
            sha256: Some("a".repeat(64)),
            bytes: Some(1024),
            duration_frames: Some(90),
            width: Some(1920),
            height: Some(1080),
            sample_rate: None,
            channels: None,
            fps: Some(FrameRateDto::new(30, 1)),
            codec: Some("h264".into()),
            container: Some("mp4".into()),
            origin: "imported".into(),
            parent_asset_id: None,
            generation_job_id: None,
            prompt_revision_id: None,
            probe: Some(serde_json::json!({ "durationSeconds": 3.0 })),
            missing_at: None,
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn create_project_installs_the_default_timeline() {
        let connection = project_database();
        let document = load_document(&connection).unwrap();
        assert_eq!(document.sequences.len(), 1);
        assert!(document.sequences[0].is_active);
        assert_eq!(document.tracks.len(), 8, "3 video + 4 audio + 1 caption");
        assert_eq!(
            document
                .tracks
                .iter()
                .filter(|track| track.kind == "video")
                .count(),
            3
        );
        assert_eq!(document.tracks[0].name, "V1");
        assert!(document.clips.is_empty());
        assert_eq!(document.project.title, "Fixture");
    }

    #[test]
    fn document_round_trips_through_save_and_load() {
        let mut connection = project_database();
        let mut document = load_document(&connection).unwrap();
        let track_id = document.tracks[0].id.clone();
        let sequence_id = document.sequences[0].id.clone();
        document.clips.push(ClipDto {
            id: "clp_1".into(),
            track_id: track_id.clone(),
            sequence_id: sequence_id.clone(),
            asset_id: None,
            label: "Shot 1".into(),
            start_frame: 10,
            source_in_frame: 5,
            duration_frames: 60,
            properties: serde_json::json!({
                "speed": { "num": 2, "den": 1 },
                "transform": { "x": 12.0, "y": -4.0, "scale": 1.0, "rotation": 0.0, "opacity": 0.5 },
                "crop": { "top": 0.0, "right": 0.0, "bottom": 0.0, "left": 0.0 },
                "audio": { "gainDb": -6.0, "fadeInFrames": 0, "fadeOutFrames": 0, "enabled": true, "pan": 0.0 }
            }),
            version: 3,
            created_at: "2024-01-02T00:00:00.000Z".into(),
            updated_at: "2024-01-02T00:00:00.000Z".into(),
        });
        document.effects.push(EffectDto {
            id: "fx_1".into(),
            clip_id: "clp_1".into(),
            kind: "brightness".into(),
            sort_order: 0,
            enabled: true,
            params: serde_json::json!({ "amount": 0.25 }),
            created_at: "2024-01-02T00:00:00.000Z".into(),
            updated_at: "2024-01-02T00:00:00.000Z".into(),
        });
        document.keyframes.push(KeyframeDto {
            id: "kf_1".into(),
            effect_id: "fx_1".into(),
            property: "amount".into(),
            frame: 30,
            value: serde_json::json!(0.75),
            easing: "linear".into(),
            created_at: "2024-01-02T00:00:00.000Z".into(),
        });
        document.assets.push(fixture_asset("ast_1"));

        let saved = save_document(&mut connection, &document).unwrap();
        assert_eq!(saved.clips, 1);
        assert_eq!(saved.tracks, 8);
        assert_eq!(saved.schema_version, 1);

        let reloaded = load_document(&connection).unwrap();
        assert_eq!(reloaded.clips.len(), 1);
        assert_eq!(reloaded.clips[0].label, "Shot 1");
        assert_eq!(clip_speed(&reloaded.clips[0]), (2, 1));
        assert_eq!(reloaded.clips[0].properties["transform"]["opacity"], 0.5);
        assert_eq!(reloaded.effects.len(), 1);
        assert_eq!(reloaded.effects[0].params["amount"], 0.25);
        assert_eq!(reloaded.keyframes.len(), 1);
        assert_eq!(reloaded.keyframes[0].value, serde_json::json!(0.75));
        assert_eq!(reloaded.assets.len(), 1);
        assert_eq!(reloaded.assets[0].id, "ast_1");
        assert_eq!(reloaded.assets[0].fps, Some(FrameRateDto::new(30, 1)));
    }

    #[test]
    fn save_document_replaces_rather_than_appends() {
        let mut connection = project_database();
        let mut document = load_document(&connection).unwrap();
        let track_id = document.tracks[0].id.clone();
        let sequence_id = document.sequences[0].id.clone();
        let clip = ClipDto {
            id: "clp_1".into(),
            track_id,
            sequence_id,
            asset_id: None,
            label: "A".into(),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 30,
            properties: serde_json::json!({}),
            version: 1,
            created_at: "2024-01-02T00:00:00.000Z".into(),
            updated_at: "2024-01-02T00:00:00.000Z".into(),
        };
        document.clips.push(clip.clone());
        save_document(&mut connection, &document).unwrap();
        save_document(&mut connection, &document).unwrap();
        assert_eq!(load_document(&connection).unwrap().clips.len(), 1);

        document.clips.clear();
        save_document(&mut connection, &document).unwrap();
        assert!(load_document(&connection).unwrap().clips.is_empty());
    }

    #[test]
    fn assets_are_upserted_and_deduplicated_by_sha256() {
        let connection = project_database();
        let asset = fixture_asset("ast_1");
        insert_asset(&connection, &asset).unwrap();
        insert_asset(&connection, &asset).unwrap();
        assert_eq!(list_assets(&connection).unwrap().len(), 1);
        let found = find_asset_by_sha256(&connection, &asset.sha256.clone().unwrap())
            .unwrap()
            .expect("sha256 lookup");
        assert_eq!(found.id, "ast_1");
        assert!(find_asset_by_sha256(&connection, "b").unwrap().is_none());

        let updated = update_asset(
            &connection,
            "ast_1",
            &serde_json::json!({ "missingAt": "2024-02-01T00:00:00.000Z" }),
        )
        .unwrap();
        assert_eq!(
            updated.missing_at.as_deref(),
            Some("2024-02-01T00:00:00.000Z")
        );
        delete_asset(&connection, "ast_1").unwrap();
        assert!(list_assets(&connection).unwrap().is_empty());
        assert!(delete_asset(&connection, "ast_1").is_err());
    }

    #[test]
    fn jobs_round_trip_and_append_events() {
        let mut connection = project_database();
        let job = insert_job(
            &connection,
            &serde_json::json!({
                "providerId": "elevenlabs",
                "modelId": "eleven_multilingual_v2",
                "mode": "text-to-speech",
                "modality": "audio",
                "status": "queued",
                "idempotencyKey": "idem_abc",
                "request": { "prompt": "hello" },
                "outputAssetIds": [],
            }),
        )
        .unwrap();
        assert_eq!(job.status, "queued");
        assert_eq!(job.retry_count, 0);

        let updated = update_job(
            &mut connection,
            &job.id,
            &JobUpdate {
                status: Some("running".into()),
                progress: Some(0.4),
                provider_job_id: Some("prov_1".into()),
                ..JobUpdate::default()
            },
            Some(JobEvent {
                from_state: Some("queued".into()),
                to_state: "running".into(),
                detail: Some(serde_json::json!({ "attempt": 1 })),
            }),
        )
        .unwrap();
        assert_eq!(updated.status, "running");
        assert_eq!(updated.progress, Some(0.4));
        assert_eq!(updated.provider_job_id.as_deref(), Some("prov_1"));

        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM job_events WHERE job_id = ?",
                [&job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);

        let listed = list_jobs(&connection, Some(&["running".to_string()]), None).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(list_jobs(&connection, Some(&["failed".to_string()]), None)
            .unwrap()
            .is_empty());
        assert_eq!(list_unfinished_jobs(&connection).unwrap().len(), 1);
    }

    #[test]
    fn settings_round_trip() {
        let connection = project_database();
        assert!(get_setting(&connection, "theme").unwrap().is_none());
        set_setting(&connection, "theme", &serde_json::json!("dark")).unwrap();
        set_setting(&connection, "theme", &serde_json::json!("light")).unwrap();
        assert_eq!(
            get_setting(&connection, "theme").unwrap(),
            Some(serde_json::json!("light"))
        );
        set_setting(&connection, "budget", &serde_json::json!({ "dailyUsd": 5 })).unwrap();
        let all = all_settings(&connection).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["budget"]["dailyUsd"], 5);
    }

    #[test]
    fn export_jobs_round_trip() {
        let connection = project_database();
        let row = ExportJobRow {
            id: "exp_1".into(),
            project_id: "prj_test".into(),
            sequence_id: "seq_1".into(),
            preset: serde_json::json!({ "id": "1080p" }),
            output_path: "/tmp/out.mp4".into(),
            status: "rendering".into(),
            progress: 0.25,
            rendered_frames: 30,
            total_frames: 120,
            errors: vec![],
            log_path: None,
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        };
        insert_export_job(&connection, &row).unwrap();
        let mut updated = row.clone();
        updated.progress = 0.5;
        updated.rendered_frames = 60;
        updated.status = "completed".into();
        updated.errors = vec!["warning: colour range".into()];
        update_export_job(&connection, &updated).unwrap();

        let found = find_export_job(&connection, "exp_1").unwrap().unwrap();
        assert_eq!(found.progress, 0.5);
        assert_eq!(found.status, "completed");
        assert_eq!(found.errors.len(), 1);
        assert_eq!(list_export_jobs(&connection, 10).unwrap().len(), 1);
    }

    #[test]
    fn provider_configs_upsert_on_the_scoped_unique_index() {
        let connection = project_database();
        let config = ProviderConfigRow {
            id: String::new(),
            project_id: None,
            provider_id: "elevenlabs".into(),
            enabled: true,
            base_url: None,
            credential_ref: Some("keyring:com.creativelab.studio:provider:elevenlabs".into()),
            auth_scheme: "header".into(),
            extra_headers: serde_json::json!({ "xi-api-key": "<handle>" }),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let first = upsert_provider_config(&connection, &config).unwrap();
        let second = upsert_provider_config(&connection, &config).unwrap();
        assert_eq!(first.id, second.id, "scoped upsert must reuse the row");
        assert_eq!(list_provider_configs(&connection).unwrap().len(), 1);
    }

    #[test]
    fn model_catalog_upserts_on_provider_model_modality() {
        let mut connection = project_database();
        let entry = ProviderModelDto {
            provider_id: "elevenlabs".into(),
            model_id: "eleven_multilingual_v2".into(),
            display_name: "Multilingual v2".into(),
            modality: "audio".into(),
            capabilities: serde_json::json!({ "languages": 29 }),
            pricing: Some(serde_json::json!({ "perCharacter": 0.00003 })),
            fetched_at: "2024-01-01T00:00:00.000Z".into(),
            is_stale: false,
        };
        upsert_model_catalog(&mut connection, std::slice::from_ref(&entry)).unwrap();
        let mut stale = entry.clone();
        stale.display_name = "Renamed".into();
        stale.is_stale = true;
        upsert_model_catalog(&mut connection, std::slice::from_ref(&stale)).unwrap();

        let listed = list_model_catalog(&connection, Some("elevenlabs")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].display_name, "Renamed");
        assert!(listed[0].is_stale);
        assert_eq!(listed[0].pricing.as_ref().unwrap()["perCharacter"], 0.00003);
        assert_eq!(list_model_catalog(&connection, None).unwrap().len(), 1);
    }

    #[test]
    fn spend_ledger_round_trips() {
        let connection = project_database();
        record_spend(
            &connection,
            &SpendRow {
                id: "spd_1".into(),
                project_id: Some("prj_test".into()),
                job_id: None,
                provider_id: "elevenlabs".into(),
                amount: 0.12,
                currency: "USD".into(),
                kind: "actual".into(),
                day: "2024-01-01".into(),
                created_at: "2024-01-01T00:00:00.000Z".into(),
            },
        )
        .unwrap();
        let all = list_spend(&connection, None, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].amount, 0.12);
        assert_eq!(
            list_spend(&connection, Some("2024-01-01"), None)
                .unwrap()
                .len(),
            1
        );
        assert!(list_spend(&connection, Some("2024-01-02"), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn project_ref_reports_a_missing_project_clearly() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate::run_migrations(&mut connection).unwrap();
        let error = project_ref(&connection).unwrap_err();
        assert!(error.message.contains("no project"), "{error}");
        assert!(load_document(&connection).is_err());
    }

    #[test]
    fn clip_speed_falls_back_to_one_when_absent_or_invalid() {
        let mut clip = ClipDto {
            id: "clp_1".into(),
            track_id: "trk_1".into(),
            sequence_id: "seq_1".into(),
            asset_id: None,
            label: String::new(),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 1,
            properties: serde_json::json!({}),
            version: 1,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert_eq!(clip_speed(&clip), (1, 1));
        clip.properties = serde_json::json!({ "speed": { "num": 2, "den": 0 } });
        assert_eq!(clip_speed(&clip), (2, 1));
        clip.properties = serde_json::json!({ "speed": { "num": 1, "den": 2 } });
        assert_eq!(clip_speed(&clip), (1, 2));
    }
}
