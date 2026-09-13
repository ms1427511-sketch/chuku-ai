import type { HairstyleCatalogEntry } from "../../shared/types.ts";

export function HairstyleCatalog({
  hairstyles,
  selectedId,
  onSelect,
  onGenerate,
  generating,
  disabled,
}: {
  hairstyles: HairstyleCatalogEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onGenerate: () => void;
  generating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="hairstyle-catalog">
      <div className="hairstyle-grid">
        {hairstyles.map((h) => (
          <button
            key={h.id}
            type="button"
            className={h.id === selectedId ? "hairstyle-card selected" : "hairstyle-card"}
            onClick={() => onSelect(h.id)}
          >
            <span className="hairstyle-name">{h.name}</span>
            <span className="hairstyle-category">{h.category}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="try-this-style"
        disabled={!selectedId || generating || disabled}
        onClick={onGenerate}
      >
        {generating ? "Generating…" : "Try This Style"}
      </button>
    </div>
  );
}
