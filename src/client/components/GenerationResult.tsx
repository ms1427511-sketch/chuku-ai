import type { GenerationRecord, PortraitId } from "../../shared/types.ts";

function resultUrl(record: GenerationRecord): string | null {
  if (!record.resultPath) return null;
  // Served by the local server only — never a remote LightX URL kept live in the UI.
  return `/api/results/${record.resultPath}`;
}

export function GenerationResult({
  source,
  record,
  onRework,
  onChooseThisStyle,
  isFavorite,
  reworking,
}: {
  source: PortraitId;
  record: GenerationRecord;
  onRework: () => void;
  onChooseThisStyle: () => void;
  isFavorite: boolean;
  reworking: boolean;
}) {
  const url = resultUrl(record);
  return (
    <div className="generation-result">
      <div className="side-by-side">
        <figure>
          <figcaption>Original ({source})</figcaption>
          <img src={`/api/input/${source}`} alt="original portrait" />
        </figure>
        <figure>
          <figcaption>
            Result #{record.generationIndex} — {record.status}
          </figcaption>
          {url ? <img src={url} alt="generated hairstyle result" /> : <div className="placeholder">no image</div>}
        </figure>
      </div>

      <div className="metrics">
        <span>provider: {record.provider}</span>
        <span>hairstyle: {record.hairstyleId}</span>
        <span>generation #: {record.generationIndex}</span>
        <span>status: {record.status}</span>
        <span>latency: {record.latencyMs !== null ? `${record.latencyMs}ms` : "n/a"}</span>
        {record.failureCategory && <span>failure: {record.failureCategory}</span>}
      </div>

      <div className="actions">
        <button type="button" onClick={onRework} disabled={reworking}>
          {reworking ? "Reworking…" : "Rework / Try Again"}
        </button>
        <button type="button" onClick={onChooseThisStyle} disabled={record.status !== "completed"}>
          {isFavorite ? "★ Chosen" : "Choose This Style"}
        </button>
      </div>
    </div>
  );
}
