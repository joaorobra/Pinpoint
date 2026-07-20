import React, { useCallback, useEffect, useRef, useState } from "react";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import {
  motion,
  AnimatePresence,
  MotionConfig,
  useReducedMotion,
} from "framer-motion";
import {
  PushPin,
  Sun,
  Moon,
  MarkdownLogo,
  FileText,
  Table,
  Kanban,
  ListBullets,
  MagnifyingGlass,
  ArrowsClockwise,
  CalendarBlank,
  Hash,
  Flag,
  CloudCheck,
  WifiSlash,
  PaintBrush,
  NotePencil,
  LockOpen,
  Check,
  CheckCircle,
  DownloadSimple,
  GithubLogo,
} from "@phosphor-icons/react";

/* ============================================================
   Constants & shared helpers
   ============================================================ */

const STATIC =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("static");
const EASE = [0.32, 0.72, 0, 1];
const RELEASES = "https://github.com/joaorobra/Pinpoint/releases";
const REPO = "https://github.com/joaorobra/Pinpoint";

function useTheme() {
  const [theme, setThemeState] = useState(() => {
    let initial = "light";
    try {
      const q = new URLSearchParams(window.location.search).get("theme");
      initial = q || localStorage.getItem("pinpoint-theme") || "light";
    } catch {
      /* fall through */
    }
    document.documentElement.dataset.theme = initial; // before anything renders
    return initial;
  });
  const setTheme = useCallback((next) => {
    setThemeState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      document.documentElement.dataset.theme = value; // synchronously, not in an effect
      try {
        localStorage.setItem("pinpoint-theme", value);
      } catch {
        /* private mode */
      }
      return value;
    });
  }, []);
  return [theme, setTheme];
}

function Reveal({ children, delay = 0, className }) {
  if (STATIC) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** Types `text` letter by letter while `play` is true; returns the visible slice. */
function useTypewriter(text, { play = true, speed = 45, startDelay = 0 } = {}) {
  const [len, setLen] = useState(play ? 0 : text.length);
  useEffect(() => {
    if (!play) {
      setLen(text.length);
      return undefined;
    }
    setLen(0);
    let i = 0;
    let t;
    const step = () => {
      i += 1;
      setLen(i);
      if (i < text.length) t = setTimeout(step, speed + Math.random() * 45);
    };
    t = setTimeout(step, startDelay + speed);
    return () => clearTimeout(t);
  }, [text, play, speed, startDelay]);
  return text.slice(0, len);
}

/** Offscreen + hover pause plumbing shared by the autopilot mocks. */
function usePauseRefs(settled) {
  const hostRef = useRef(null);
  const visRef = useRef(true);
  const hoverRef = useRef(false);
  useEffect(() => {
    if (settled) return undefined;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(
      ([e]) => {
        visRef.current = e.isIntersecting;
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [settled]);
  const hostProps = {
    ref: hostRef,
    onPointerEnter: () => {
      hoverRef.current = true;
    },
    onPointerLeave: () => {
      hoverRef.current = false;
    },
  };
  const paused = useCallback(
    () => !visRef.current || hoverRef.current,
    []
  );
  return { hostProps, paused };
}

/** Auto-resume timer: takeOver() hands control to the visitor, auto resumes later. */
function useTakeover(settled, resumeAfter = 14000) {
  const [auto, setAuto] = useState(!settled);
  const timer = useRef();
  const takeOver = useCallback(() => {
    setAuto(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAuto(true), resumeAfter);
  }, [resumeAfter]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { auto: auto && !settled, takeOver };
}

/* ============================================================
   Squared-grid hero background (canvas 2D, token-colored).
   Graph-paper grid; cells softly light up in the accent and a
   selection square hops between cells like a block cursor.
   ============================================================ */

function cssRgb255(name) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const m = v.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function GridBackground({ theme }) {
  const canvasRef = useRef(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined; // fallback: plain --bg shows through
    const dark = theme === "dark";
    const [tr, tg, tb] = cssRgb255("--text");
    const [ar, ag, ab] = cssRgb255("--accent");
    const lineColor = `rgba(${tr}, ${tg}, ${tb}, ${dark ? 0.09 : 0.075})`;
    const accent = (a) => `rgba(${ar}, ${ag}, ${ab}, ${a})`;
    const CELL = 46;
    const settled = STATIC || reduce;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let cell = CELL;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      cell = CELL * dpr;
      const cw = Math.round(canvas.clientWidth * dpr);
      const ch = Math.round(canvas.clientHeight * dpr);
      if (cw !== w || ch !== h) {
        w = cw;
        h = ch;
        canvas.width = w;
        canvas.height = h;
      }
    };

    const pulses = []; // {c, r, t0, dur}
    let sel = { c: 4, r: 3, fc: 4, fr: 3, t0: 0 };
    const rand = (n) => Math.floor(Math.random() * n);

    const fillCell = (c, r, alpha) => {
      ctx.fillStyle = accent(alpha);
      ctx.fillRect(c * cell + 1, r * cell + 1, cell - 1, cell - 1);
    };

    const drawFrame = (t) => {
      resize();
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x <= w; x += cell) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0.5; y <= h; y += cell) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      for (const p of pulses) {
        const k = (t - p.t0) / p.dur;
        if (k < 0 || k > 1) continue;
        fillCell(p.c, p.r, Math.sin(Math.PI * k) * (dark ? 0.17 : 0.14));
      }

      // selection square, eased hop between cells
      const k = Math.min((t - sel.t0) / 0.45, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const x = (sel.fc + (sel.c - sel.fc) * e) * cell;
      const y = (sel.fr + (sel.r - sel.fr) * e) * cell;
      ctx.fillStyle = accent(0.1);
      ctx.fillRect(x + 1, y + 1, cell - 1, cell - 1);
      ctx.strokeStyle = accent(0.8);
      ctx.lineWidth = Math.max(1.5, 1.25 * dpr);
      ctx.strokeRect(x + 0.5, y + 0.5, cell, cell);
    };

    if (settled) {
      const still = () => {
        resize();
        const cols = Math.max(4, Math.floor(w / cell));
        const rows = Math.max(4, Math.floor(h / cell));
        pulses.length = 0;
        // fixed, pleasant arrangement at pulse peak (t = dur / 2)
        [
          [0.12, 0.22],
          [0.3, 0.68],
          [0.55, 0.15],
          [0.72, 0.55],
          [0.88, 0.3],
          [0.2, 0.45],
        ].forEach(([cx, cy]) => {
          pulses.push({
            c: Math.round(cols * cx),
            r: Math.round(rows * cy),
            t0: -2,
            dur: 4,
          });
        });
        sel = { c: Math.round(cols * 0.62), r: Math.round(rows * 0.72) };
        sel.fc = sel.c;
        sel.fr = sel.r;
        sel.t0 = -1;
        drawFrame(0);
      };
      still();
      const ro = new ResizeObserver(still);
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    let raf;
    const start = performance.now();
    const step = (now) => {
      const t = (now - start) / 1000;
      const cols = Math.max(4, Math.floor(w / cell) || 20);
      const rows = Math.max(4, Math.floor(h / cell) || 14);
      if (pulses.length < 7 && Math.random() < 0.035) {
        pulses.push({
          c: rand(cols),
          r: rand(rows),
          t0: t,
          dur: 3.5 + Math.random() * 3,
        });
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        if (t - pulses[i].t0 > pulses[i].dur) pulses.splice(i, 1);
      }
      if (t - sel.t0 > 2.6) {
        sel = {
          fc: sel.c,
          fr: sel.r,
          t0: t,
          c: Math.max(1, Math.min(cols - 2, sel.c + rand(7) - 3)),
          r: Math.max(1, Math.min(rows - 2, sel.r + rand(7) - 3)),
        };
      }
      drawFrame(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(step);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [theme, reduce]); // re-run on theme change so token colors refresh
  return (
    <div className="grid-bg" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ============================================================
   Small shared UI atoms
   ============================================================ */

function TaskCheck({ checked, ghost, onClick, label }) {
  const cls = `task-check${checked ? " checked" : ""}`;
  if (ghost) return <span className={cls} aria-hidden="true" />;
  return (
    <button
      type="button"
      className={cls}
      aria-label={label}
      aria-pressed={checked}
      onClick={onClick}
    >
      {checked ? <Check size={11} weight="bold" aria-hidden="true" /> : null}
    </button>
  );
}

function TaskRow({ done, children, pills }) {
  return (
    <div className={`task-row${done ? " done" : ""}`}>
      <TaskCheck checked={done} ghost label="Example task" />
      <span className="task-text">{children}</span>
      {pills}
    </div>
  );
}

const StatusPill = ({ status }) => {
  const cls =
    status === "Done"
      ? "pill-status-done"
      : status === "In progress"
        ? "pill-status-progress"
        : "pill-status-todo";
  return <span className={`pill ${cls}`}>{status}</span>;
};

const PrioPill = ({ prio }) =>
  prio === "Low" ? null : (
    <span className={`pill ${prio === "High" ? "pill-high" : "pill-med"}`}>
      <Flag size={10} weight="fill" aria-hidden="true" />
      {prio}
    </span>
  );

/* ============================================================
   Hero — the Pinpoint app window (live mock)
   ============================================================ */

const SIDEBAR = [
  {
    section: "Periodic",
    items: [
      { id: "daily", label: "2026-07-19", icon: CalendarBlank },
      { id: "weekly", label: "2026-W29", icon: CalendarBlank },
    ],
  },
  {
    section: "Pages",
    items: [
      { id: "atlas", label: "Atlas Launch", icon: FileText },
      { id: "reading", label: "Reading List", icon: FileText },
    ],
  },
  {
    section: "Databases",
    items: [{ id: "projects", label: "Projects", icon: Table }],
  },
];

const WINDOW_ORDER = ["daily", "atlas", "projects", "weekly"];

function WindowContent({ id }) {
  if (id === "daily")
    return (
      <>
        <h4>Saturday, July 19</h4>
        <TaskRow
          done
          pills={<span className="pill pill-done">done 08:12</span>}
        >
          Morning pages
        </TaskRow>
        <TaskRow
          pills={
            <>
              <PrioPill prio="High" />
              <span className="pill pill-tag">#focus</span>
            </>
          }
        >
          Review <span className="wikilink">[[Atlas Launch]]</span> plan
        </TaskRow>
        <TaskRow
          pills={
            <span className="pill pill-recur">
              <ArrowsClockwise size={10} aria-hidden="true" /> monthly
            </span>
          }
        >
          Pay rent
        </TaskRow>
        <TaskRow
          pills={
            <>
              <PrioPill prio="Medium" />
              <span className="pill pill-tag">#health</span>
            </>
          }
        >
          Book dentist
        </TaskRow>
        <div className="pin-h2">Notes</div>
        <p>
          This window is a live demo of the real app. Click the files on the
          left.
        </p>
      </>
    );
  if (id === "weekly")
    return (
      <>
        <h4>Week 29 · Jul 13 to 19</h4>
        <p>Focus: get the beta into testers&rsquo; hands.</p>
        <TaskRow done pills={<span className="pill pill-done">done Jul 15</span>}>
          Cut v0.5.0 release
        </TaskRow>
        <TaskRow pills={<span className="pill pill-tag">#product</span>}>
          Collect beta feedback
        </TaskRow>
        <TaskRow>Plan week 30</TaskRow>
      </>
    );
  if (id === "atlas")
    return (
      <>
        <h4>Atlas Launch</h4>
        <div className="task-row" style={{ gap: 6, paddingBottom: 10 }}>
          <StatusPill status="In progress" />
          <span className="pill pill-recur">due Aug 2</span>
          <span className="pill pill-tag">#marketing</span>
        </div>
        <p>
          Everything for the v1 launch, from the announcement post to the
          rollout checklist.
        </p>
        <div className="pin-h2">Next steps</div>
        <TaskRow pills={<PrioPill prio="High" />}>
          Draft announcement post
        </TaskRow>
        <TaskRow pills={<PrioPill prio="Medium" />}>
          Ship beta to testers
        </TaskRow>
        <TaskRow done pills={<span className="pill pill-done">done Jul 18</span>}>
          Set up landing page
        </TaskRow>
      </>
    );
  if (id === "reading")
    return (
      <>
        <h4>Reading List</h4>
        {[
          ["Four Thousand Weeks", "Oliver Burkeman"],
          ["How to Take Smart Notes", "Sönke Ahrens"],
          ["The Shape of Design", "Frank Chimero"],
        ].map(([t, a]) => (
          <div className="db-list-row" key={t}>
            <FileText size={14} aria-hidden="true" />
            <span className="db-name">{t}</span>
            <span className="db-due">{a}</span>
          </div>
        ))}
      </>
    );
  // projects database
  return (
    <>
      <h4>Projects</h4>
      <table className="db-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Atlas Launch", "In progress", "Aug 2"],
            ["Website refresh", "In progress", "Aug 9"],
            ["Q3 planning", "Not started", "Aug 15"],
            ["Home office redo", "Done", "Jul 12"],
          ].map(([n, s, d]) => (
            <tr key={n}>
              <td className="db-name">{n}</td>
              <td>
                <StatusPill status={s} />
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function PinpointWindow() {
  const reduce = useReducedMotion();
  const settled = STATIC || reduce;
  const [active, setActive] = useState("daily");
  const { hostProps, paused } = usePauseRefs(settled);
  const { auto, takeOver } = useTakeover(settled);

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => {
      if (paused()) return;
      setActive(
        (cur) =>
          WINDOW_ORDER[
            (WINDOW_ORDER.indexOf(cur) + 1 + WINDOW_ORDER.length) %
              WINDOW_ORDER.length
          ] ?? "daily"
      );
    }, 5000);
    return () => clearInterval(id);
  }, [auto, paused]);

  return (
    <div
      className="mock pin-window-shell"
      role="application"
      aria-label="Interactive demo of the Pinpoint app: a sidebar of markdown files and an editor. Use the file buttons to switch pages."
      {...hostProps}
    >
      <div className="mock-titlebar">
        <PushPin size={13} weight="fill" aria-hidden="true" />
        My Vault · Pinpoint
        <span className="live-chip">live demo</span>
        <span className="mock-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="pin-window">
        <nav className="pin-sidebar" aria-label="Demo vault files">
          {SIDEBAR.map((sec) => (
            <div key={sec.section}>
              <div className="pin-section">{sec.section}</div>
              {sec.items.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`pin-file${active === f.id ? " active" : ""}`}
                  onClick={() => {
                    setActive(f.id);
                    takeOver();
                  }}
                >
                  <f.icon size={13} aria-hidden="true" />
                  {f.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="pin-editor">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={STATIC ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: EASE }}
            >
              <WindowContent id={active} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Feature mock 1 — WYSIWYG ↔ file on disk round-trip
   ============================================================ */

const RT_PHRASES = [
  "Ship the beta to testers",
  "Email the waitlist #marketing",
  "Write the v1 changelog",
];

function RoundTripMock() {
  const reduce = useReducedMotion();
  const settled = STATIC || reduce;
  const { hostProps, paused } = usePauseRefs(settled);
  const [userText, setUserText] = useState(null);
  const [autoText, setAutoText] = useState(settled ? RT_PHRASES[0] : "");

  useEffect(() => {
    if (settled || userText !== null) return undefined;
    let phrase = 0;
    let i = 0;
    let t;
    const step = () => {
      if (paused()) {
        t = setTimeout(step, 900);
        return;
      }
      const target = RT_PHRASES[phrase];
      if (i < target.length) {
        i += 1;
        setAutoText(target.slice(0, i));
        t = setTimeout(step, 75 + Math.random() * 45);
      } else {
        // hold, then move to the next phrase
        t = setTimeout(() => {
          phrase = (phrase + 1) % RT_PHRASES.length;
          i = 0;
          setAutoText("");
          t = setTimeout(step, 600);
        }, 2400);
      }
    };
    t = setTimeout(step, 800);
    return () => clearTimeout(t);
  }, [settled, userText, paused]);

  const line = userText !== null ? userText : autoText;

  return (
    <div className="mock" {...hostProps}>
      <div className="mock-titlebar">
        <MarkdownLogo size={14} aria-hidden="true" />
        Projects / Atlas Launch.md
        <span className="live-chip">live demo</span>
        <span className="mock-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="rt-body">
        <div className="rt-pane">
          <div className="rt-label">What you see</div>
          <div className="rt-title">Atlas Launch</div>
          <div className="task-row" style={{ gap: 6, paddingBottom: 8 }}>
            <StatusPill status="In progress" />
            <span className="pill pill-recur">due Aug 2</span>
          </div>
          <TaskRow pills={<span className="pill pill-tag">#marketing</span>}>
            Draft announcement post
          </TaskRow>
          {userText === null ? (
            <div className="task-row">
              <TaskCheck ghost />
              <span className="task-text">
                {line}
                {!settled ? <span className="caret" /> : null}
              </span>
            </div>
          ) : null}
          <input
            className="rt-input"
            type="text"
            placeholder="Try it: type a task…"
            aria-label="Type a task to see it written to the markdown file"
            value={userText ?? ""}
            onFocus={() => setUserText((v) => v ?? "")}
            onChange={(e) => setUserText(e.target.value)}
          />
        </div>
        <div className="rt-pane">
          <div className="rt-label">What&rsquo;s on disk</div>
          <div className="rt-raw">
            {"---\n"}
            <span className="rt-key">status:</span>
            {" In progress\n"}
            <span className="rt-key">due:</span>
            {" 2026-08-02\n"}
            {"---\n"}
            {"# Atlas Launch\n"}
            {"- [ ] Draft announcement post #marketing\n"}
            <span className="rt-live">
              {"- [ ] "}
              {line}
            </span>
          </div>
        </div>
      </div>
      <div className="mock-footnote">
        Fields are YAML frontmatter, tasks are <code>- [ ]</code>. Standard
        markdown, byte for byte.
      </div>
    </div>
  );
}

/* ============================================================
   Feature mock 2 — database views (table / board / list)
   ============================================================ */

const DB_ROWS = [
  { name: "Atlas Launch", status: "In progress", due: "Aug 2", prio: "High" },
  { name: "Website refresh", status: "In progress", due: "Aug 9", prio: "Medium" },
  { name: "Q3 planning", status: "Not started", due: "Aug 15", prio: "Medium" },
  { name: "Reading backlog", status: "Not started", due: "no date", prio: "Low" },
  { name: "Home office redo", status: "Done", due: "Jul 12", prio: "Low" },
];

const DB_VIEWS = [
  { id: "table", label: "Table", icon: Table },
  { id: "board", label: "Board", icon: Kanban },
  { id: "list", label: "List", icon: ListBullets },
];

function DbRows({ view }) {
  const item = {
    initial: STATIC ? false : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
  };
  if (view === "table")
    return (
      <table className="db-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Status</th>
            <th>Due</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          {DB_ROWS.map((r, i) => (
            <motion.tr
              key={r.name}
              {...item}
              transition={{ duration: 0.3, ease: EASE, delay: i * 0.05 }}
            >
              <td className="db-name">{r.name}</td>
              <td>
                <StatusPill status={r.status} />
              </td>
              <td>{r.due}</td>
              <td>
                <PrioPill prio={r.prio} /> {r.prio === "Low" ? "Low" : null}
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    );
  if (view === "board") {
    const cols = ["Not started", "In progress", "Done"];
    return (
      <div className="db-board">
        {cols.map((c) => (
          <div key={c}>
            <div className="db-col-head">{c}</div>
            {DB_ROWS.filter((r) => r.status === c).map((r, i) => (
              <motion.div
                className="db-card"
                key={r.name}
                {...item}
                transition={{ duration: 0.3, ease: EASE, delay: i * 0.06 }}
              >
                {r.name}
                <div className="db-card-meta">
                  <PrioPill prio={r.prio} />
                  <span className="pill pill-recur">{r.due}</span>
                </div>
              </motion.div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div>
      {DB_ROWS.map((r, i) => (
        <motion.div
          className="db-list-row"
          key={r.name}
          {...item}
          transition={{ duration: 0.3, ease: EASE, delay: i * 0.05 }}
        >
          <FileText size={14} aria-hidden="true" />
          <span className="db-name">{r.name}</span>
          <StatusPill status={r.status} />
          <span className="db-due">{r.due}</span>
        </motion.div>
      ))}
    </div>
  );
}

function DatabaseMock() {
  const reduce = useReducedMotion();
  const settled = STATIC || reduce;
  const [view, setView] = useState("table");
  const { hostProps, paused } = usePauseRefs(settled);
  const { auto, takeOver } = useTakeover(settled);

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => {
      if (paused()) return;
      setView((v) => {
        const i = DB_VIEWS.findIndex((x) => x.id === v);
        return DB_VIEWS[(i + 1) % DB_VIEWS.length].id;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [auto, paused]);

  return (
    <div
      className="mock"
      role="application"
      aria-label="Interactive database demo: the same five project notes shown as a table, a board and a list. Use the view buttons to switch."
      {...hostProps}
    >
      <div className="mock-titlebar">
        <Table size={14} aria-hidden="true" />
        Projects · 5 notes
        <span className="live-chip">live demo</span>
        <span className="mock-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="db-tabs" role="tablist" aria-label="Database views">
        {DB_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className={`db-tab${view === v.id ? " active" : ""}`}
            onClick={() => {
              setView(v.id);
              takeOver();
            }}
          >
            <v.icon size={13} aria-hidden="true" />
            {v.label}
          </button>
        ))}
      </div>
      <div className="db-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={STATIC ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <DbRows view={view} />
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="mock-footnote">
        Each row is a plain <code>.md</code> file. Its fields live in
        frontmatter.
      </div>
    </div>
  );
}

/* ============================================================
   Feature mock 3 — query DSL with live results
   ============================================================ */

const Q_KEYWORDS = new Set([
  "TABLE",
  "LIST",
  "TASK",
  "FROM",
  "WHERE",
  "SORT",
  "ASC",
  "DESC",
  "AND",
]);

const Q_PRESETS = [
  {
    label: "Open tasks",
    dsl: "TASK WHERE done = false SORT due ASC",
    render: () => (
      <div>
        {[
          ["Review Atlas Launch plan", "Jul 21", "#focus"],
          ["Book dentist", "Jul 24", "#health"],
          ["Pay rent", "Aug 1", null],
          ["Draft announcement post", "Aug 1", "#marketing"],
        ].map(([t, d, tag], i) => (
          <motion.div
            className="task-row"
            key={t}
            initial={STATIC ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE, delay: i * 0.07 }}
          >
            <TaskCheck ghost />
            <span className="task-text">{t}</span>
            {tag ? <span className="pill pill-tag">{tag}</span> : null}
            <span className="pill pill-recur">{d}</span>
          </motion.div>
        ))}
      </div>
    ),
  },
  {
    label: "Projects in flight",
    dsl: 'TABLE status, due FROM "Projects" WHERE status != "Done" SORT due ASC',
    render: () => (
      <table className="db-table">
        <thead>
          <tr>
            <th>Page</th>
            <th>Status</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {DB_ROWS.filter((r) => r.status !== "Done").map((r, i) => (
            <motion.tr
              key={r.name}
              initial={STATIC ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: i * 0.07 }}
            >
              <td className="db-name">{r.name}</td>
              <td>
                <StatusPill status={r.status} />
              </td>
              <td>{r.due}</td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    ),
  },
  {
    label: "Reading list",
    dsl: "LIST FROM #reading SORT file.name ASC",
    render: () => (
      <div>
        {[
          "Four Thousand Weeks",
          "How to Take Smart Notes",
          "The Shape of Design",
        ].map((t, i) => (
          <motion.div
            className="db-list-row"
            key={t}
            initial={STATIC ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE, delay: i * 0.07 }}
          >
            <FileText size={14} aria-hidden="true" />
            <span className="db-name">{t}</span>
            <span className="pill pill-tag">#reading</span>
          </motion.div>
        ))}
      </div>
    ),
  },
];

function renderDsl(str) {
  return str.split(/(\s+)/).map((tok, i) =>
    Q_KEYWORDS.has(tok) ? (
      <span className="q-kw" key={i}>
        {tok}
      </span>
    ) : (
      <React.Fragment key={i}>{tok}</React.Fragment>
    )
  );
}

function QueryMock() {
  const reduce = useReducedMotion();
  const settled = STATIC || reduce;
  const [index, setIndex] = useState(0);
  const { hostProps, paused } = usePauseRefs(settled);
  const { auto, takeOver } = useTakeover(settled);
  const preset = Q_PRESETS[index];

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => {
      if (paused()) return;
      setIndex((i) => (i + 1) % Q_PRESETS.length);
    }, 6500);
    return () => clearInterval(id);
  }, [auto, paused]);

  const typed = useTypewriter(preset.dsl, { play: !settled, speed: 26 });
  const ready = settled || typed === preset.dsl;

  return (
    <div
      className="mock"
      role="application"
      aria-label="Interactive query demo: pick a saved query and watch it typed out with live results below."
      {...hostProps}
    >
      <div className="mock-titlebar">
        <MagnifyingGlass size={14} aria-hidden="true" />
        Query · whole vault
        <span className="live-chip">live demo</span>
        <span className="mock-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="q-presets">
        {Q_PRESETS.map((p, i) => (
          <button
            key={p.label}
            type="button"
            className={`q-preset${i === index ? " active" : ""}`}
            onClick={() => {
              setIndex(i);
              takeOver();
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="q-code">
        {renderDsl(typed)}
        {!ready ? <span className="caret" /> : null}
      </div>
      <div className="q-results">
        <AnimatePresence mode="wait" initial={false}>
          {ready ? (
            <motion.div key={index} exit={{ opacity: 0 }}>
              {preset.render()}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ============================================================
   Feature mock 4 — recurring task, future occurrences ahead
   ============================================================ */

const REC_DATES = [
  "Aug 1",
  "Sep 1",
  "Oct 1",
  "Nov 1",
  "Dec 1",
  "Jan 1",
  "Feb 1",
  "Mar 1",
  "Apr 1",
  "May 1",
];

function RecurrenceMock() {
  const reduce = useReducedMotion();
  const settled = STATIC || reduce;
  const [start, setStart] = useState(0);
  const [completing, setCompleting] = useState(settled);
  const { hostProps, paused } = usePauseRefs(settled);
  const { auto, takeOver } = useTakeover(settled);
  const timer = useRef();

  const complete = useCallback(() => {
    setCompleting((was) => {
      if (was) return was;
      timer.current = setTimeout(() => {
        setStart((s) => (s + 1) % (REC_DATES.length - 4));
        setCompleting(false);
      }, 1300);
      return true;
    });
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => {
      if (paused()) return;
      complete();
    }, 4500);
    return () => clearInterval(id);
  }, [auto, paused, complete]);

  const visible = REC_DATES.slice(start, start + 4);

  return (
    <div
      className="mock"
      role="application"
      aria-label="Interactive recurring-task demo: a monthly task with its future occurrences listed. Check the next one off and the schedule rolls forward."
      {...hostProps}
    >
      <div className="rec-head">
        <ArrowsClockwise size={15} aria-hidden="true" style={{ color: "var(--accent)" }} />
        Pay rent
        <span className="pill pill-recur">every month</span>
        <span className="live-chip" style={{ marginLeft: "auto" }}>
          live demo
        </span>
      </div>
      <div className="rec-list">
        <AnimatePresence mode="popLayout" initial={false}>
          {visible.map((d, i) => {
            const isNext = i === 0;
            const done = isNext && completing;
            return (
              <motion.div
                layout
                key={d + start}
                className={`rec-row${!isNext ? " ghost" : ""}${done ? " done task-row" : ""}`}
                initial={STATIC ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.32, ease: EASE }}
              >
                <TaskCheck
                  checked={done}
                  ghost={!isNext}
                  label={`Complete the ${d} occurrence`}
                  onClick={() => {
                    takeOver();
                    complete();
                  }}
                />
                <span className="task-text">Pay rent</span>
                {done ? (
                  <span className="pill pill-done">
                    <Check size={10} weight="bold" aria-hidden="true" /> done
                  </span>
                ) : null}
                <span className="rec-date">{d}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div className="rec-hint">
          One rule on one task. Future occurrences are computed, never
          duplicated. Check one off and watch the schedule roll forward.
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Page sections
   ============================================================ */

function Nav({ theme, setTheme }) {
  const onHome = useLocation().pathname === "/";
  // Anchor links only resolve on the home page; from other routes send them
  // back to the home page first (/#features), otherwise use a bare hash.
  const hash = (id) => (onHome ? `#${id}` : `/#${id}`);
  return (
    <header className="nav">
      <Link to="/" className="nav-brand">
        <img src="/logo.png" alt="" className="brand-logo" width={22} height={22} />
        PINPOINT
      </Link>
      <nav className="nav-links" aria-label="Main">
        <a href={hash("features")}>Features</a>
        <a href={hash("more")}>Everything else</a>
        <a href={hash("story")}>Why</a>
        <Link to="/about">About</Link>
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <button
          type="button"
          className="theme-toggle"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? (
            <Sun size={17} aria-hidden="true" />
          ) : (
            <Moon size={17} aria-hidden="true" />
          )}
        </button>
        <a className="btn btn-primary btn-sm" href={RELEASES}>
          Download free
        </a>
      </nav>
    </header>
  );
}

const heroItem = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

function Hero({ theme }) {
  return (
    <section className="hero" id="top">
      <GridBackground theme={theme} />
      <div className="container">
        <motion.div
          className="hero-grid"
          initial={STATIC ? "show" : "hidden"}
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.09 } } }}
        >
          <div>
            <motion.h1 variants={heroItem}>
              Your notes and your to-dos, <em>together</em> at last.
            </motion.h1>
            <motion.p className="lede" variants={heroItem}>
              No more splitting your brain across two apps. Pinpoint holds your
              notes and tasks side by side — quietly organized, always fast, and
              saved as plain markdown in a folder that&rsquo;s yours.
            </motion.p>
            <motion.div className="hero-ctas" variants={heroItem}>
              <a className="btn btn-primary btn-lg" href={RELEASES}>
                <DownloadSimple size={19} aria-hidden="true" />
                Download for free
              </a>
              <a className="btn btn-secondary btn-lg" href="#features">
                See how it helps
              </a>
            </motion.div>
            <motion.p className="hero-note" variants={heroItem}>
              <span>Free</span>
              <span>Windows, macOS &amp; Linux</span>
              <span>No account, ever</span>
            </motion.p>
          </div>
          <motion.div variants={heroItem}>
            <PinpointWindow />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    kicker: "Plain files",
    icon: MarkdownLogo,
    title: "Write once, keep it forever",
    body: "Everything you type is saved as ordinary markdown on your own disk. Open the same file in any editor, today or in twenty years, and it still reads perfectly. No proprietary format, no export button, no lock-in.",
    bullets: [
      "Edit visually like Notion while the file on disk stays clean markdown",
      "Back up, sync or version your notes like any other folder",
      "Quit Pinpoint tomorrow and every note still opens anywhere",
    ],
    mock: RoundTripMock,
  },
  {
    kicker: "Databases",
    icon: Table,
    title: "See your projects the way you need them today",
    body: "Give any folder of notes fields like status, due date and priority, then browse it as a table, a board or a list. It feels like Notion, and every row is still a file you can open and edit by hand.",
    bullets: [
      "Switch between table, board and list views of the same notes",
      "Change a field once and every view updates instantly",
      "Fields live in frontmatter, readable in any text editor",
    ],
    mock: DatabaseMock,
  },
  {
    kicker: "Queries",
    icon: MagnifyingGlass,
    title: "Stop hunting through pages for open tasks",
    body: "Ask your vault a question and get a live answer: every open task, every project in flight, everything tagged #reading. Build the filter with clicks or type one line, then keep the result right inside a page.",
    bullets: [
      "One query gathers tasks scattered across dozens of notes",
      "Results update the moment any file changes",
      "Visual builder for everyone, a typed DSL for power users",
    ],
    mock: QueryMock,
  },
  {
    kicker: "Recurring tasks",
    icon: ArrowsClockwise,
    title: "Set the rent reminder once, then forget it",
    body: "Write one rule like every month and Pinpoint lays all the future occurrences out ahead of you. Check one off and the schedule rolls forward on its own. No duplicate reminders, nothing to clean up.",
    bullets: [
      "Plan weeks ahead, because the future is already on the page",
      "Works for daily habits, monthly bills and yearly renewals",
      "One task and one rule, never a pile of copies",
    ],
    mock: RecurrenceMock,
  },
];

function Features() {
  return (
    <section id="features">
      <div className="container">
        <Reveal className="section-head">
          <h2>Four everyday chores, handled for you</h2>
          <p>
            Less time organizing, more time doing. And everything stays in
            plain files you own.
          </p>
        </Reveal>
        {FEATURES.map((f, i) => (
          <div className="feature" key={f.kicker}>
            <Reveal className="feature-copy">
              <div className="feature-head">
                <span className="feature-index" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="feature-kicker">
                  <f.icon size={15} aria-hidden="true" />
                  {f.kicker}
                </span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              <ul className="feature-bullets">
                {f.bullets.map((b) => (
                  <li key={b}>
                    <Check size={14} weight="bold" aria-hidden="true" />
                    {b}
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.08}>
              <f.mock />
            </Reveal>
          </div>
        ))}
      </div>
    </section>
  );
}

const MORE = [
  {
    icon: CalendarBlank,
    title: "Periodic notes",
    body: "Today's note is one click away, already started from your template.",
  },
  {
    icon: CloudCheck,
    title: "Your cloud, your sync",
    body: "Point it at a Drive, Dropbox or OneDrive folder. Your existing sync just works.",
  },
  {
    icon: WifiSlash,
    title: "Works offline",
    body: "No account, no server. A plane is a perfectly good office.",
  },
  {
    icon: NotePencil,
    title: "Templates",
    body: "Start pages and periodic notes from templates you write once.",
  },
  {
    icon: Hash,
    title: "#Tags everywhere",
    body: "Tag tasks and pages, then filter and query by them.",
  },
  {
    icon: Flag,
    title: "Priorities & due dates",
    body: "Flag what matters, see what's due, sort by both.",
  },
  {
    icon: PaintBrush,
    title: "Themes & fonts",
    body: "Pick an accent and a font, and the whole app follows.",
  },
  {
    icon: LockOpen,
    title: "Free, no strings",
    body: "No subscription, no upsell, no telemetry. Your notes are yours.",
  },
];

function More() {
  return (
    <section id="more" className="section-band">
      <div className="container">
        <Reveal className="section-head">
          <h2>All the little things, thought through</h2>
          <p>
            The everyday details that decide whether a notes app sticks.
          </p>
        </Reveal>
        <div className="more-grid">
          {MORE.map((m, i) => (
            <Reveal
              key={m.title}
              className="more-card"
              delay={(i % 2) * 0.06}
            >
              <m.icon size={20} aria-hidden="true" />
              <h4>{m.title}</h4>
              <p>{m.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Story() {
  return (
    <section id="story">
      <div className="container">
        <Reveal className="story">
          <span className="story-kicker">
            Why I made this
          </span>
          <div className="story-body">
            <p>
              I tried just about every alternative to Notion, mostly to escape
              the monthly subscription that never felt cheap. Then I spent a
              long while with Obsidian, wrestling with its plugins and
              complexity until organizing my notes felt like a second job.
            </p>
            <p>
              What I actually wanted was simple: one place for my notes{" "}
              <em>and</em> my tasks &mdash; my routines, my plans for the
              future, the half-formed ideas &mdash; all together, without the
              friction. Nothing I found did it the way I needed.
            </p>
            <p>
              So I built Pinpoint my way. Plain markdown files I own, notes and
              tasks side by side, and none of the overhead. If it&rsquo;s useful
              to you too, that makes me happy.
            </p>
          </div>
          <p className="story-sign">&mdash; The maker of Pinpoint</p>
        </Reveal>
      </div>
    </section>
  );
}

function Blobs() {
  const reduce = useReducedMotion();
  const still = STATIC || reduce;
  const blobs = [
    { size: 340, top: "-15%", left: "-8%", dx: 60, dy: 40, dur: 24 },
    { size: 280, bottom: "-20%", right: "-6%", dx: -50, dy: -30, dur: 28 },
    { size: 220, top: "30%", right: "20%", dx: 40, dy: 50, dur: 26 },
  ];
  return (
    <div className="bg-blobs" aria-hidden="true">
      {blobs.map((b, i) => (
        <motion.span
          key={i}
          style={{
            width: b.size,
            height: b.size,
            top: b.top,
            left: b.left,
            right: b.right,
            bottom: b.bottom,
          }}
          animate={
            still
              ? undefined
              : { x: [0, b.dx, 0], y: [0, b.dy, 0], scale: [1, 1.12, 1] }
          }
          transition={{
            duration: b.dur,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 2.5,
          }}
        />
      ))}
    </div>
  );
}

function Download() {
  return (
    <section id="download">
      <div className="container">
        <Reveal>
          <div className="download-card">
            <Blobs />
            <h2>Spend your energy on the work, not the system.</h2>
            <p>
              Download Pinpoint, point it at a folder, and start writing.
              Notes, tasks and projects settle into one place. And if you ever
              stop using it, that folder is still full of perfectly ordinary
              markdown. That&rsquo;s the whole point.
            </p>
            <a className="btn btn-primary btn-lg" href={RELEASES}>
              <DownloadSimple size={19} aria-hidden="true" />
              Download for free
            </a>
            <div className="download-meta">
              {[
                "Free & open on GitHub",
                "Windows, macOS & Linux",
                "No account, no telemetry",
                "Works offline",
              ].map((t) => (
                <span key={t}>
                  <CheckCircle size={15} weight="fill" aria-hidden="true" />
                  {t}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const onHome = useLocation().pathname === "/";
  const hash = (id) => (onHome ? `#${id}` : `/#${id}`);
  return (
    <footer>
      <div className="container footer-row">
        <div>
          <div className="footer-brand">
            <img src="/logo.png" alt="" className="brand-logo" width={18} height={18} />
            PINPOINT
          </div>
          <div className="footer-tagline">
            Notes, tasks and databases in plain markdown files you own.
          </div>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <a href={hash("features")}>Features</a>
          <a href={hash("more")}>Everything else</a>
          <a href={hash("story")}>Why</a>
          <Link to="/about">About</Link>
          <a href={hash("download")}>Download</a>
          <a href={REPO} target="_blank" rel="noreferrer">
            <GithubLogo
              size={15}
              aria-hidden="true"
              style={{ verticalAlign: "-2px", marginRight: 4 }}
            />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}

function Home({ theme }) {
  return (
    <>
      <Hero theme={theme} />
      <Features />
      <More />
      <Story />
      <Download />
    </>
  );
}

function About() {
  return (
    <section id="about" className="about">
      <div className="container">
        <Reveal className="about-body">
          <span className="story-kicker">About Pinpoint</span>
          <h1>One home for your notes and your tasks.</h1>
          <p>
            Pinpoint is a free, local-first notes and tasks app for Windows,
            macOS and Linux. Everything you write is saved as ordinary markdown
            in a folder you own &mdash; no account, no server, no lock-in.
          </p>
          <div className="pin-h2">What it&rsquo;s for</div>
          <p>
            Notes, tasks, databases, live queries, recurring tasks and daily
            notes, all side by side. It feels like Notion to use, but every page
            is a plain <code>.md</code> file you can open in any editor, back up,
            sync or keep for good.
          </p>
          <div className="pin-h2">Who makes it</div>
          <p>
            Pinpoint is built and maintained in the open. The source lives on{" "}
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            , where you can follow along, report issues or contribute.
          </p>
          <div className="hero-ctas" style={{ marginTop: 28 }}>
            <a className="btn btn-primary btn-lg" href={RELEASES}>
              <DownloadSimple size={19} aria-hidden="true" />
              Download for free
            </a>
            <Link className="btn btn-secondary btn-lg" to="/">
              Back to home
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Scroll to top on route change (but honor in-page #hash links). */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) return; // let the browser jump to the anchor
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

export default function App() {
  const [theme, setTheme] = useTheme();
  return (
    <MotionConfig reducedMotion="user">
      <ScrollManager />
      <Nav theme={theme} setTheme={setTheme} />
      <main>
        <Routes>
          <Route path="/" element={<Home theme={theme} />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
      <Footer />
    </MotionConfig>
  );
}
