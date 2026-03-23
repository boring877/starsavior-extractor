import { useEffect, useState, useCallback } from "react";
import {
  getDefaults,
  runDecryptBundles,
  runDecryptTemplets,
  runExtractImages,
  stopProcess,
  subscribeLogs,
  subscribeState,
} from "../api/desktopApi";
import type { AppDefaults, ExtractionState } from "../api/types";

const MAX_LOGS = 500;

function pushLog(logs: string[], line: string): string[] {
  return [...logs, line].slice(-MAX_LOGS);
}

export function useExtraction() {
  const [defaults, setDefaults] = useState<AppDefaults | null>(null);
  const [status, setStatus] = useState("Idle");
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    let offLog: () => void = () => {};
    let offState: () => void = () => {};

    getDefaults().then((d) => {
      if (!d) return;
      setDefaults(d);
    });

    subscribeLogs((line) => setLogs((c) => pushLog(c, line))).then((fn) => { offLog = fn; });
    subscribeState((state: ExtractionState) => {
      if (!state) return;
      setRunning(state.running);
      if (state.status) setStatus(state.status);
    }).then((fn) => { offState = fn; });

    return () => { offLog(); offState(); };
  }, []);

  const wrap = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setLogs((c) => pushLog(c, `--- ${label} ---`));
    try {
      const result = await fn() as { ok?: boolean; error?: string };
      if (result && !result.ok && result.error) {
        setLogs((c) => pushLog(c, `ERROR: ${result.error}`));
      }
    } catch (e) {
      setLogs((c) => pushLog(c, `ERROR: ${e}`));
    }
  }, []);

  const doDecryptBundles = useCallback((force = false) =>
    wrap("Decrypt bundles", () => runDecryptBundles(force)), [wrap]);

  const doDecryptTemplets = useCallback(() =>
    wrap("Decrypt templets", () => runDecryptTemplets()), [wrap]);

  const doExtractImages = useCallback((force = false) =>
    wrap("Extract images", () => runExtractImages(force)), [wrap]);

  const doStop = useCallback(async () => {
    const result = await stopProcess();
    if (!result.ok) setLogs((c) => pushLog(c, `ERROR: ${result.error || "Failed to stop"}`));
  }, []);

  const doFullExtract = useCallback(async () => {
    await wrap("Step 1: Decrypt bundles", () => runDecryptBundles(false));
    await wrap("Step 2: Decrypt templets", () => runDecryptTemplets());
    await wrap("Step 3: Extract images", () => runExtractImages(false));
    setLogs((c) => pushLog(c, "--- Done ---"));
  }, [wrap]);

  return { defaults, status, running, logs, doDecryptBundles, doDecryptTemplets, doExtractImages, doFullExtract, doStop };
}
