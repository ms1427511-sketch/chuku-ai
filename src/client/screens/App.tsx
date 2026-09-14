import { useEffect, useState } from "react";
import type { BenchmarkTotals, FailureFlag, GenerationRecord, HairstyleCatalogEntry, ManualScore, PortraitId } from "../../shared/types.ts";
import {
  createGeneration,
  fetchHairstyles,
  fetchHistory,
  fetchTotals,
  reworkGeneration,
  updateFavorite,
  updateFlags,
  updateScore,
} from "../api/client.ts";
import { PortraitSelector } from "../components/PortraitSelector.tsx";
import { HairstyleCatalog } from "../components/HairstyleCatalog.tsx";
import { GenerationResult } from "../components/GenerationResult.tsx";
import { HistoryList } from "../components/HistoryList.tsx";
import { ManualScorePanel } from "../components/ManualScorePanel.tsx";

// This is the CHUKU AI LAB benchmark/testing console — NOT the final
// MEKKY mobile interface. It exists to evaluate LightX output quality
// against real product requirements before any product integration.
export function App() {
  const [source, setSource] = useState<PortraitId>("portrait-a");
  const [hairstyles, setHairstyles] = useState<HairstyleCatalogEntry[]>([]);
  const [selectedHairstyleId, setSelectedHairstyleId] = useState<string | null>(null);
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [active, setActive] = useState<GenerationRecord | null>(null);
  const [totals, setTotals] = useState<BenchmarkTotals | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reworking, setReworking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHairstyles().then((r) => setHairstyles(r.hairstyles));
    fetchTotals().then((r) => setTotals(r.totals));
  }, []);

  useEffect(() => {
    fetchHistory(source).then((r) => setHistory(r.generations));
  }, [source, active]);

  async function refreshTotals() {
    const r = await fetchTotals();
    setTotals(r.totals);
  }

  async function handleGenerate() {
    if (!selectedHairstyleId) return;
    setError(null);
    setGenerating(true);
    try {
      const { generation } = await createGeneration({ source, hairstyleId: selectedHairstyleId });
      setActive(generation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setGenerating(false);
      await refreshTotals();
    }
  }

  async function handleRework() {
    if (!active) return;
    setError(null);
    setReworking(true);
    try {
      const { generation } = await reworkGeneration(active.id);
      setActive(generation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "rework failed");
    } finally {
      setReworking(false);
      await refreshTotals();
    }
  }

  async function handleChooseThisStyle() {
    if (!active) return;
    const { generation } = await updateFavorite(active.id, true);
    setActive(generation);
    const r = await fetchHistory(source);
    setHistory(r.generations);
  }

  async function handleSaveScore(score: ManualScore) {
    if (!active) return;
    const { generation } = await updateScore(active.id, score);
    setActive(generation);
  }

  async function handleSaveFlags(flags: FailureFlag[]) {
    if (!active) return;
    const { generation } = await updateFlags(active.id, flags);
    setActive(generation);
  }

  const capReached = totals ? totals.remaining <= 0 : false;

  return (
    <main className="chuku-lab">
      <header>
        <h1>CHUKU AI LAB</h1>
        <p className="subtitle">Benchmark console for AI hairstyle generation. Not the MEKKY product UI.</p>
        {totals && (
          <p className="totals">
            requested {totals.requested}/{totals.hardCap} · succeeded {totals.succeeded} · failed {totals.failed} ·
            retries {totals.retries} · remaining {totals.remaining}
          </p>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      <section>
        <h2>1. Source portrait</h2>
        <PortraitSelector
          selected={source}
          onSelect={(id) => {
            setSource(id);
            setActive(null);
          }}
        />
      </section>

      <section>
        <h2>2. Hairstyle</h2>
        <HairstyleCatalog
          hairstyles={hairstyles}
          selectedId={selectedHairstyleId}
          onSelect={setSelectedHairstyleId}
          onGenerate={handleGenerate}
          generating={generating}
          disabled={capReached}
        />
        {capReached && <p className="cap-warning">Generation hard cap reached for this benchmark run.</p>}
      </section>

      {active && (
        <section>
          <h2>3. Result</h2>
          <GenerationResult
            source={source}
            record={active}
            onRework={handleRework}
            onChooseThisStyle={handleChooseThisStyle}
            reworking={reworking}
          />
          <ManualScorePanel record={active} onSaveScore={handleSaveScore} onSaveFlags={handleSaveFlags} />
        </section>
      )}

      <section>
        <h2>History for {source}</h2>
        <HistoryList records={history} onSelect={setActive} />
      </section>
    </main>
  );
}
