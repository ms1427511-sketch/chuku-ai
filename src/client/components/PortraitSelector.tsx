import type { PortraitId } from "../../shared/types.ts";

const PORTRAITS: { id: PortraitId; label: string }[] = [
  { id: "portrait-a", label: "Portrait A" },
  { id: "portrait-b", label: "Portrait B" },
  { id: "portrait-c", label: "Portrait C" },
];

export function PortraitSelector({
  selected,
  onSelect,
}: {
  selected: PortraitId;
  onSelect: (id: PortraitId) => void;
}) {
  return (
    <div className="portrait-selector">
      {PORTRAITS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={p.id === selected ? "selected" : ""}
          onClick={() => onSelect(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
