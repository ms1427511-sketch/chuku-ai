import type { GenerationRecord } from "../../shared/types.ts";

export function HistoryList({
  records,
  onSelect,
}: {
  records: GenerationRecord[];
  onSelect: (record: GenerationRecord) => void;
}) {
  if (records.length === 0) {
    return <p className="history-empty">No generations yet for this source/style.</p>;
  }
  return (
    <ul className="history-list">
      {records.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onSelect(r)}>
            #{r.generationIndex} · {r.hairstyleId} · {r.status}
            {r.retryOf ? " · rework" : ""}
            {r.favorite ? " · ★" : ""}
          </button>
        </li>
      ))}
    </ul>
  );
}
