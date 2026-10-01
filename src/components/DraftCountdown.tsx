// How long a Seedance 2.5 draft has left before its 1080p final can no longer be
// rendered. BytePlus keeps a draft for 7 days; after that the only way to a final
// is a new draft, so the time left is shown where the artist reviews the draft,
// not tucked into the button's tooltip.
//
// Two sizes: the card's strip, which ticks every second, and the grid tile's chip,
// which ticks every minute because a contact sheet is scanned rather than watched.
// Both read draftCountdown(), the same rule that disables the button, so the clock
// reaching zero and the button turning off happen together.

import { CheckCircle2, Hourglass, TimerOff } from "lucide-react";
import type { Job } from "../types";
import { draftCountdown, draftCountdownShortText, type DraftCountdownPhase } from "../features/jobs/draftFinal";
import { useNow } from "../utils/useNow";

const DEADLINE_DATE = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short" });
const DEADLINE_TIME = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

/** "today, 11:15 AM", "tomorrow, 09:04 AM", or "Thu, Oct 8, 09:04 AM". */
function deadlineText(deadline: number, now: number) {
  const day = (time: number) => new Date(time).toDateString();
  const time = DEADLINE_TIME.format(deadline);
  if (day(deadline) === day(now)) return `today, ${time}`;
  if (day(deadline) === day(now + 86_400_000)) return `tomorrow, ${time}`;
  return `${DEADLINE_DATE.format(deadline)}, ${time}`;
}

const PHASE_EYEBROW: Record<DraftCountdownPhase, string> = {
  fresh: "Draft · time left to render the 1080p final",
  soon: "Draft · under 3 days left",
  urgent: "Draft · final hours",
  expired: "Draft · expired",
};

type DraftCountdownProps = {
  job: Job;
  /** The newest final rendered from this draft, when there is one. */
  finalStatus?: Job["status"];
};

export function DraftCountdown({ job, finalStatus }: DraftCountdownProps) {
  const now = useNow(1000);
  const countdown = draftCountdown(job.draft, now);
  if (!countdown) return null;

  const { phase } = countdown;
  const deadline = deadlineText(countdown.deadline, now);
  const finalDone = finalStatus === "completed";
  const note =
    phase === "expired"
      ? "BytePlus no longer keeps this draft. Render a new draft to get a 1080p final."
      : finalDone
        ? `A final is already in Results. You can render it again until ${deadline}.`
        : `Approve it and render the 1080p final before ${deadline}.`;

  return (
    <section
      className="draft-clock"
      data-phase={phase}
      role="timer"
      aria-label={phase === "expired" ? "Draft expired" : `Draft expires ${deadline}`}
      title="Seedance keeps a draft for 7 days. Momi stops offering the final 30 minutes early, so a final that starts always finds its draft."
    >
      <DraftRing
        fraction={countdown.fraction}
        phase={phase}
        days={countdown.days}
        hours={countdown.hours}
        minutes={countdown.minutes}
      />
      <div className="min-w-0 flex-1">
        <p className="draft-clock-eyebrow">
          {phase === "expired" ? <TimerOff className="h-2.5 w-2.5" /> : <Hourglass className="h-2.5 w-2.5" />}
          {PHASE_EYEBROW[phase]}
        </p>
        {phase === "expired" ? (
          <p className="draft-clock-expired">00:00:00</p>
        ) : (
          <div className="draft-clock-digits" aria-hidden="true">
            <ClockUnit value={countdown.days} label="days" />
            <ClockUnit value={countdown.hours} label="hrs" />
            <ClockUnit value={countdown.minutes} label="min" />
            <ClockUnit value={countdown.seconds} label="sec" />
          </div>
        )}
        <p className="draft-clock-note">
          {finalDone && phase !== "expired" ? <CheckCircle2 className="h-2.5 w-2.5 shrink-0" /> : null}
          {note}
        </p>
      </div>
    </section>
  );
}

function ClockUnit({ value, label }: { value: number; label: string }) {
  return (
    <span className="draft-clock-unit">
      {/* Keyed on the value so each change replays the tick-in. */}
      <span key={value} className="draft-clock-value">
        {String(value).padStart(2, "0")}
      </span>
      <span className="draft-clock-label">{label}</span>
    </span>
  );
}

const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The window as a dial: the arc is the time left, one notch per day of the seven. */
function DraftRing({
  fraction,
  phase,
  days,
  hours,
  minutes,
}: {
  fraction: number;
  phase: DraftCountdownPhase;
  days: number;
  hours: number;
  minutes: number;
}) {
  // The largest unit still running, so the dial never reads "0" while time is left.
  const [centre, unit] =
    phase === "expired"
      ? ["0", "left"]
      : days > 0
        ? [`${days}`, days === 1 ? "day" : "days"]
        : hours > 0
          ? [`${hours}`, hours === 1 ? "hr" : "hrs"]
          : [`${Math.max(1, minutes)}`, "min"];
  return (
    <span className="draft-clock-ring" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="48" height="48">
        <circle className="draft-clock-ring-track" cx="32" cy="32" r={RING_RADIUS} />
        <circle
          className="draft-clock-ring-arc"
          cx="32"
          cy="32"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
        />
        {Array.from({ length: 7 }, (_, index) => {
          const angle = (index / 7) * 2 * Math.PI - Math.PI / 2;
          return (
            <line
              key={index}
              className="draft-clock-ring-notch"
              x1={32 + Math.cos(angle) * 29}
              y1={32 + Math.sin(angle) * 29}
              x2={32 + Math.cos(angle) * 31.5}
              y2={32 + Math.sin(angle) * 31.5}
            />
          );
        })}
      </svg>
      <span className="draft-clock-ring-centre">
        <span className="draft-clock-ring-number">{centre}</span>
        <span className="draft-clock-ring-unit">{unit}</span>
      </span>
    </span>
  );
}

/** The grid tile's version: a small dial and "6d 23h", over the poster frame. */
export function DraftCountdownChip({ job }: { job: Job }) {
  const now = useNow(60_000);
  const countdown = draftCountdown(job.draft, now);
  if (!countdown) return null;
  const size = 12;
  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className="draft-chip"
      data-phase={countdown.phase}
      title={
        countdown.phase === "expired"
          ? "This draft has expired"
          : `Draft: render the 1080p final before ${deadlineText(countdown.deadline, now)}`
      }
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="draft-chip-track" cx="6" cy="6" r={radius} />
        <circle
          className="draft-chip-arc"
          cx="6"
          cy="6"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - countdown.fraction)}
        />
      </svg>
      {draftCountdownShortText(countdown)}
    </span>
  );
}
