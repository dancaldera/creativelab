//! Shared application state.
//!
//! One process, one open workspace. Opening a project replaces the root and the database
//! connection atomically behind [`AppState::open_workspace`].
//!
//! ## Locking
//! `Mutex<Connection>` is a hard requirement: `rusqlite::Connection` is `Send` but not
//! `Sync`, so it cannot live in Tauri's managed state unprotected. Commands are declared
//! *synchronous* precisely so that Tauri runs them on its blocking thread pool — a
//! synchronous `#[tauri::command]` that locks this mutex can never block the async
//! runtime, which is what makes the plain `Mutex` safe here (no `.await` is ever held
//! across the lock).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;

use crate::db::store::ProjectRef;
use crate::error::{CommandError, CommandResult};
use crate::security::WorkspaceScope;

/// A handle a running render job exposes so `render_cancel` can stop it.
///
/// `canceled` is checked by the render loop (between progress lines and before the final
/// rename); `kill` escalates SIGTERM -> SIGKILL on the ffmpeg child.
pub struct RenderCancelHandle {
    pub canceled: Arc<AtomicBool>,
    pub export_job_id: String,
    /// Populated once the child is spawned. `None` while still preparing inputs.
    pub kill: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl std::fmt::Debug for RenderCancelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenderCancelHandle")
            .field("export_job_id", &self.export_job_id)
            .field("canceled", &self.canceled.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl RenderCancelHandle {
    pub fn new(export_job_id: impl Into<String>) -> Self {
        Self {
            canceled: Arc::new(AtomicBool::new(false)),
            export_job_id: export_job_id.into(),
            kill: Mutex::new(None),
        }
    }

    /// Ask ffmpeg to stop. SIGTERM first so it can flush; the caller escalates.
    pub fn request_cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
        if let Ok(guard) = self.kill.lock() {
            if let Some(kill) = guard.as_ref() {
                kill();
            }
        }
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    pub fn set_kill(&self, kill: Box<dyn Fn() + Send + Sync>) {
        if let Ok(mut guard) = self.kill.lock() {
            *guard = Some(kill);
        }
    }
}

/// A recent-project entry, persisted in `app_settings` under `recentProjects`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub title: String,
    pub workspace_path: String,
    pub updated_at: String,
}

pub struct AppState {
    workspace_root: RwLock<Option<PathBuf>>,
    database: Mutex<Option<Connection>>,
    /// `export_job_id` -> cancel handle for every in-flight render.
    render_jobs: Mutex<HashMap<String, Arc<RenderCancelHandle>>>,
    recent_projects: RwLock<Vec<RecentProject>>,
    /// Monotonic counter backing [`next_id`]; combined with a v4 UUID for uniqueness.
    sequence: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("workspace_root", &self.workspace_root())
            .field("has_database", &self.has_workspace())
            .field("running_renders", &self.render_job_ids().len())
            .finish()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace_root: RwLock::new(None),
            database: Mutex::new(None),
            render_jobs: Mutex::new(HashMap::new()),
            recent_projects: RwLock::new(Vec::new()),
            sequence: AtomicU64::new(1),
        }
    }

    // -----------------------------------------------------------------------
    // Workspace
    // -----------------------------------------------------------------------

    /// `true` when a workspace is open and its database is live.
    pub fn has_workspace(&self) -> bool {
        self.workspace_root
            .read()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
            && self
                .database
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false)
    }

    pub fn workspace_root(&self) -> Option<PathBuf> {
        self.workspace_root
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// The current workspace scope, or `workspace_required`-style validation error.
    pub fn scope(&self) -> CommandResult<WorkspaceScope> {
        self.workspace_root()
            .map(WorkspaceScope::new)
            .ok_or_else(|| {
                CommandError::configuration("no workspace is open; open or create a project first")
            })
    }

    /// Resolve a workspace-relative path against the open workspace.
    pub fn scoped_path(&self, candidate: &str) -> CommandResult<PathBuf> {
        let root = self.workspace_root().ok_or_else(|| {
            CommandError::configuration("no workspace is open; open or create a project first")
        })?;
        let scope = WorkspaceScope::new(&root);
        Ok(scope.scope(&root, candidate)?)
    }

    /// Exchange the open workspace. Callers must have already verified the database by
    /// running migrations, so this cannot leave the app pointing at a broken project.
    pub fn set_workspace(&self, root: PathBuf, connection: Connection) -> CommandResult<()> {
        let mut root_guard = self
            .workspace_root
            .write()
            .map_err(|_| CommandError::internal("workspace lock is poisoned"))?;
        let mut db_guard = self
            .database
            .lock()
            .map_err(|_| CommandError::internal("database lock is poisoned"))?;
        *root_guard = Some(root);
        *db_guard = Some(connection);
        Ok(())
    }

    /// Close the current workspace. Any running render is cancelled first so no ffmpeg
    /// process outlives the project it was writing into.
    pub fn close_workspace(&self) -> CommandResult<()> {
        self.cancel_all_renders();
        if let Ok(mut guard) = self.workspace_root.write() {
            *guard = None;
        }
        if let Ok(mut guard) = self.database.lock() {
            *guard = None;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Database
    // -----------------------------------------------------------------------

    /// Run `f` with the open connection. Returns a configuration error when no project is
    /// open so callers never have to unwrap an `Option<Connection>`.
    pub fn with_db<T>(&self, f: impl FnOnce(&Connection) -> CommandResult<T>) -> CommandResult<T> {
        let guard = self
            .database
            .lock()
            .map_err(|_| CommandError::internal("database lock is poisoned"))?;
        let connection = guard.as_ref().ok_or_else(|| {
            CommandError::configuration("no workspace is open; open or create a project first")
        })?;
        f(connection)
    }

    /// As [`AppState::with_db`], but hands out `&mut Connection` so a caller can open a
    /// real transaction. `rusqlite::Connection::transaction` needs exclusive access, and
    /// the mutex already provides it.
    pub fn with_db_mut<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let mut guard = self
            .database
            .lock()
            .map_err(|_| CommandError::internal("database lock is poisoned"))?;
        let connection = guard.as_mut().ok_or_else(|| {
            CommandError::configuration("no workspace is open; open or create a project first")
        })?;
        f(connection)
    }

    /// The project row this workspace's database holds.
    pub fn project_ref(&self) -> CommandResult<ProjectRef> {
        self.with_db(|connection| crate::db::store::project_ref(connection))
    }

    /// Run `f` inside an immediate transaction, rolling back on error.
    pub fn with_transaction<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> CommandResult<T>,
    ) -> CommandResult<T> {
        self.with_db(|connection| {
            let transaction = connection.unchecked_transaction()?;
            let value = f(&transaction)?;
            transaction.commit()?;
            Ok(value)
        })
    }

    // -----------------------------------------------------------------------
    // Render jobs
    // -----------------------------------------------------------------------

    pub fn register_render(&self, handle: Arc<RenderCancelHandle>) -> CommandResult<()> {
        let mut guard = self
            .render_jobs
            .lock()
            .map_err(|_| CommandError::internal("render registry lock is poisoned"))?;
        guard.insert(handle.export_job_id.clone(), handle);
        Ok(())
    }

    pub fn render_handle(&self, export_job_id: &str) -> Option<Arc<RenderCancelHandle>> {
        self.render_jobs
            .lock()
            .ok()
            .and_then(|guard| guard.get(export_job_id).cloned())
    }

    pub fn unregister_render(&self, export_job_id: &str) {
        if let Ok(mut guard) = self.render_jobs.lock() {
            guard.remove(export_job_id);
        }
    }

    pub fn render_job_ids(&self) -> Vec<String> {
        self.render_jobs
            .lock()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn cancel_all_renders(&self) {
        let handles: Vec<Arc<RenderCancelHandle>> = self
            .render_jobs
            .lock()
            .map(|guard| guard.values().cloned().collect())
            .unwrap_or_default();
        for handle in handles {
            handle.request_cancel();
        }
    }

    // -----------------------------------------------------------------------
    // Recent projects (persisted in `app_settings`, mirrored from the TS store)
    // -----------------------------------------------------------------------

    pub fn recent_projects(&self) -> Vec<RecentProject> {
        self.recent_projects
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn remember_project(&self, entry: RecentProject) {
        if let Ok(mut guard) = self.recent_projects.write() {
            guard.retain(|candidate| candidate.workspace_path != entry.workspace_path);
            guard.insert(0, entry);
            guard.truncate(20);
        }
    }

    pub fn forget_project(&self, workspace_path: &str) {
        if let Ok(mut guard) = self.recent_projects.write() {
            guard.retain(|candidate| candidate.workspace_path != workspace_path);
        }
    }

    /// `prj_<24 lowercase hex>` — the same shape as `packages/core/src/ids.ts#newId`.
    pub fn next_id(&self, kind: &str) -> String {
        let prefix = match kind {
            "project" => "prj",
            "sequence" => "seq",
            "track" => "trk",
            "clip" => "clp",
            "effect" => "fx",
            "keyframe" => "kf",
            "asset" => "ast",
            "job" => "job",
            "event" => "evt",
            "promptRevision" => "prv",
            "exportJob" => "exp",
            "providerConfig" => "pcfg",
            "catalogEntry" => "cat",
            "spend" => "spd",
            "snapshot" => "snp",
            other => other,
        };
        let counter = self.sequence.fetch_add(1, Ordering::Relaxed);
        let uuid = uuid::Uuid::new_v4().simple().to_string();
        // 16 hex chars of uuid + 8 hex chars of the counter = 24, matching core's length.
        format!("{prefix}_{}{:08x}", &uuid[..16], counter as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_match_the_core_shape() {
        let state = AppState::new();
        let id = state.next_id("clip");
        assert!(id.starts_with("clp_"), "{id}");
        let suffix = id.trim_start_matches("clp_");
        assert_eq!(suffix.len(), 24, "{id}");
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_ne!(state.next_id("clip"), id);
    }

    #[test]
    fn scope_requires_an_open_workspace() {
        let state = AppState::new();
        assert!(!state.has_workspace());
        let error = state.scope().unwrap_err();
        assert_eq!(error.category, crate::error::ErrorCategory::Configuration);
        assert!(state.scoped_path("assets/x.png").is_err());
        assert!(state.with_db(|_| Ok(())).is_err());
    }

    #[test]
    fn cancel_handles_are_tracked_and_signalled() {
        let state = AppState::new();
        let handle = Arc::new(RenderCancelHandle::new("exp_1"));
        state.register_render(handle.clone()).unwrap();
        assert_eq!(state.render_job_ids(), vec!["exp_1".to_string()]);
        assert!(!handle.is_canceled());
        state.cancel_all_renders();
        assert!(handle.is_canceled());
        state.unregister_render("exp_1");
        assert!(state.render_job_ids().is_empty());
    }

    #[test]
    fn recent_projects_deduplicate_by_path() {
        let state = AppState::new();
        let make = |title: &str| RecentProject {
            id: "prj_1".into(),
            title: title.into(),
            workspace_path: "/tmp/one".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        };
        state.remember_project(make("First"));
        state.remember_project(make("Second"));
        let recent = state.recent_projects();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title, "Second");
    }
}
