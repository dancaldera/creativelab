/**
 * `RecoveryBanner` — offers "Recover unsaved work" vs "Discard" when
 * `ProjectSessionDto.recovery` is non-null (PRD §14: "Crash-recovery snapshot", FR-01).
 *
 * The banner never recovers silently: a snapshot is *offered*, because recovering a stale
 * snapshot over newer work would be data loss.
 */
import { useState } from "react";
import type { RecoveryOfferDto } from "../bridge/protocol";
import { formatTimestamp } from "../utils/format";

export interface RecoveryBannerProps {
  offer: RecoveryOfferDto;
  onRecover: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
}

const REASON_LABEL: Record<RecoveryOfferDto["reason"], string> = {
  periodic: "periodic crash snapshot",
  "before-edit": "snapshot taken before an edit",
  manual: "manual snapshot",
};

export function RecoveryBanner({ offer, onRecover, onDiscard }: RecoveryBannerProps) {
  const [busy, setBusy] = useState<"recover" | "discard" | null>(null);

  return (
    <div className="recovery" role="alert" aria-live="assertive">
      <span aria-hidden="true">⚠</span>
      <span>
        Unsaved work was found — a {REASON_LABEL[offer.reason]} written{" "}
        {formatTimestamp(offer.writtenAt)}.
      </span>
      <code className="mono small" title={offer.snapshotPath}>
        {offer.snapshotPath.split("/").pop()}
      </code>
      <div className="spacer" />
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy !== null}
        onClick={() => {
          setBusy("recover");
          void Promise.resolve(onRecover()).finally(() => setBusy(null));
        }}
      >
        {busy === "recover" ? "Recovering…" : "Recover unsaved work"}
      </button>
      <button
        type="button"
        className="btn btn--danger"
        disabled={busy !== null}
        onClick={() => {
          setBusy("discard");
          void Promise.resolve(onDiscard()).finally(() => setBusy(null));
        }}
      >
        {busy === "discard" ? "Discarding…" : "Discard"}
      </button>
    </div>
  );
}
