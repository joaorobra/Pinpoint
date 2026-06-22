import { useState } from "react";
import { PERIODS, Period, labelFor, pathFor, step, template } from "../periodic";

interface Props {
  periodicFolder: string;
  /** Pattern for the daily-note label/heading (see dateformat.ts). */
  dailyFormat: string;
  /** Open (creating if missing) the period note for the given path + template. */
  onOpenPeriodic: (relPath: string, fallbackBody: string) => void;
}

export default function PeriodicBar({ periodicFolder, dailyFormat, onOpenPeriodic }: Props) {
  const [period, setPeriod] = useState<Period>("daily");
  // Anchor date for navigation. Date.now() is fine in the browser/webview runtime.
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  const go = () => {
    const path = pathFor(periodicFolder, period, anchor);
    onOpenPeriodic(path, template(period, anchor, dailyFormat));
  };

  return (
    <div className="periodic-bar">
      <div className="seg periods">
        {PERIODS.map((p) => (
          <button key={p} className={p === period ? "active" : ""} onClick={() => setPeriod(p)}>
            {p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      <div className="periodic-nav">
        <button onClick={() => setAnchor((d) => step(period, d, -1))}>◀</button>
        <button className="periodic-label" onClick={go} title="Open / create this note">
          {labelFor(period, anchor, dailyFormat)}
        </button>
        <button onClick={() => setAnchor((d) => step(period, d, 1))}>▶</button>
        <button className="today" onClick={() => setAnchor(new Date())}>
          Today
        </button>
      </div>
    </div>
  );
}
