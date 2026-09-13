import { useState } from "react";
import type { FailureFlag, GenerationRecord, ManualScore } from "../../shared/types.ts";
import { UNSCORED } from "../../shared/types.ts";

const SCORE_FIELDS: { key: keyof ManualScore; label: string }[] = [
  { key: "identityPreservation", label: "Identity Preservation" },
  { key: "haircutAccuracy", label: "Haircut Accuracy" },
  { key: "realism", label: "Realism" },
  { key: "hairlineQuality", label: "Hairline Quality" },
  { key: "fadeQuality", label: "Fade Quality (or N/A)" },
  { key: "beardPreservation", label: "Beard Preservation (or N/A)" },
  { key: "artifactControl", label: "Artifact Control" },
  { key: "barberUsability", label: "Barber Usability" },
];

const FLAGS: FailureFlag[] = ["IDENTITY_FAILURE", "HAIRCUT_FAILURE"];

// Manual, human-controlled quality review. This panel never computes or
// guesses a score — every field defaults to UNSCORED (null) until a human
// enters a value (spec section 22: "system must never pretend an image is
// perfect").
export function ManualScorePanel({
  record,
  onSaveScore,
  onSaveFlags,
}: {
  record: GenerationRecord;
  onSaveScore: (score: ManualScore) => void;
  onSaveFlags: (flags: FailureFlag[]) => void;
}) {
  const [score, setScore] = useState<ManualScore>(record.score ?? UNSCORED);
  const [flags, setFlags] = useState<FailureFlag[]>(record.flags);

  function setField(key: keyof ManualScore, value: string) {
    const parsed = value === "" ? null : Math.max(0, Math.min(10, Number(value)));
    setScore((prev) => ({ ...prev, [key]: parsed }));
  }

  function toggleFlag(flag: FailureFlag) {
    setFlags((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]));
  }

  return (
    <div className="manual-score-panel">
      <h4>Manual review — generation #{record.generationIndex}</h4>
      <div className="score-grid">
        {SCORE_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={0}
              max={10}
              value={score[f.key] ?? ""}
              placeholder="UNSCORED"
              onChange={(e) => setField(f.key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <button type="button" onClick={() => onSaveScore(score)}>
        Save Score
      </button>

      <div className="failure-flags">
        {FLAGS.map((flag) => (
          <label key={flag}>
            <input type="checkbox" checked={flags.includes(flag)} onChange={() => toggleFlag(flag)} />
            {flag}
          </label>
        ))}
        <button type="button" onClick={() => onSaveFlags(flags)}>
          Save Flags
        </button>
      </div>
    </div>
  );
}
