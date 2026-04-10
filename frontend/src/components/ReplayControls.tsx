import {
  ArrowLeft,
  ArrowRight,
  CircleDot,
  DoorOpen,
  Gauge,
  Pause,
  Play,
  RotateCw,
  SkipBack,
  SkipForward,
  TrendingDown,
  TrendingUp,
} from "lucide-solid";

interface Props {
  isPlaying: boolean;
  speed: number;
  statusLabel: string;
  statusDetail: string;
  progress: number;
  currentBar: number;
  totalBars: number;
  currentTimeLabel: string;
  currentPriceLabel: string;
  positionLabel: string;
  canSeek: boolean;
  canStartPlayback: boolean;
  canStepBack: boolean;
  canStepForward: boolean;
  canJumpPrevTrade: boolean;
  canJumpNextTrade: boolean;
  canLong: boolean;
  canShort: boolean;
  canExitPosition: boolean;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (progress: number) => void;
  onRestart: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onJumpPrevTrade: () => void;
  onJumpNextTrade: () => void;
  onLong: () => void;
  onShort: () => void;
  onExit: () => void;
}

const speeds = [1, 2, 5, 8, 12, 20];

function ghostButton(enabled: boolean): string {
  return [
    "px-3 py-2 rounded-lg border text-sm transition-colors flex items-center gap-2",
    enabled
      ? "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
      : "border-zinc-800 bg-zinc-900 text-zinc-600 cursor-not-allowed",
  ].join(" ");
}

function actionButton(enabled: boolean, tone: "green" | "rose"): string {
  const activeTone =
    tone === "green"
      ? "bg-emerald-600 text-white hover:bg-emerald-500"
      : "bg-rose-600 text-white hover:bg-rose-500";

  return [
    "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
    enabled ? activeTone : "bg-zinc-800 text-zinc-500 cursor-not-allowed",
  ].join(" ");
}

export default function ReplayControls(props: Props) {
  return (
    <div class="flex flex-col gap-5 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div class="flex flex-wrap gap-3">
          <button
            onClick={props.onPlayPause}
            disabled={!props.isPlaying && !props.canStartPlayback}
            class={`px-6 py-3 rounded-lg font-medium flex items-center gap-2 transition-colors ${
              props.isPlaying || props.canStartPlayback
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
            }`}
          >
            {props.isPlaying ? (
              <>
                <Pause size={20} /> Pause
              </>
            ) : (
              <>
                <Play size={20} fill="currentColor" /> Play Replay
              </>
            )}
          </button>

          <button
            onClick={props.onRestart}
            class="px-4 py-3 text-zinc-400 hover:text-white transition-colors flex items-center gap-2"
          >
            <RotateCw size={18} />
            Restart
          </button>
        </div>

        <div class="grid grid-cols-2 gap-2 text-xs text-zinc-500 min-w-72">
          <div class="rounded-lg bg-zinc-950 px-3 py-2 col-span-2">
            <p>{props.statusLabel}</p>
            <p class="mt-1 text-zinc-200">{props.statusDetail}</p>
          </div>
          <div class="rounded-lg bg-zinc-950 px-3 py-2">
            <p>Time</p>
            <p class="font-mono text-zinc-200 mt-1">{props.currentTimeLabel}</p>
          </div>
          <div class="rounded-lg bg-zinc-950 px-3 py-2">
            <p>Price</p>
            <p class="font-mono text-zinc-200 mt-1">{props.currentPriceLabel}</p>
          </div>
          <div class="rounded-lg bg-zinc-950 px-3 py-2 col-span-2">
            <p>Position</p>
            <p class="font-mono text-zinc-200 mt-1">{props.positionLabel}</p>
          </div>
        </div>
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <CircleDot size={16} />
            TIMELINE
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={props.progress}
            disabled={!props.canSeek}
            onInput={(event) => props.onSeek(parseFloat(event.currentTarget.value))}
            class="w-full accent-emerald-500"
          />
          <div class="flex justify-between text-xs text-zinc-500">
            <span>Bar {props.currentBar} / {props.totalBars}</span>
            <span>{Math.round(props.progress * 100)}%</span>
          </div>
          {props.canSeek ? null : (
            <p class="text-xs text-zinc-500">
              Timeline is locked during the sim so you can't peek ahead.
            </p>
          )}
        </div>

        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <Gauge size={16} />
            SPEED
          </div>
          <div class="flex gap-2 flex-wrap">
            {speeds.map((speed) => (
              <button
                onClick={() => props.onSpeedChange(speed)}
                disabled={!props.canStartPlayback && !props.isPlaying}
                class={`px-4 py-1.5 rounded-lg text-sm transition-all flex items-center gap-1 ${
                  props.speed === speed
                    ? "bg-emerald-600 text-white"
                    : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                }`}
              >
                {speed}x
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <ArrowLeft size={16} />
            NAVIGATION
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              onClick={props.onStepBack}
              disabled={!props.canStepBack}
              class={ghostButton(props.canStepBack)}
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <button
              onClick={props.onStepForward}
              disabled={!props.canStepForward}
              class={ghostButton(props.canStepForward)}
            >
              Forward
              <ArrowRight size={16} />
            </button>
            <button
              onClick={props.onJumpPrevTrade}
              disabled={!props.canJumpPrevTrade}
              class={ghostButton(props.canJumpPrevTrade)}
            >
              <SkipBack size={16} />
              Prev Trade
            </button>
            <button
              onClick={props.onJumpNextTrade}
              disabled={!props.canJumpNextTrade}
              class={ghostButton(props.canJumpNextTrade)}
            >
              Next Trade
              <SkipForward size={16} />
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <TrendingUp size={16} />
            MANUAL ACTIONS
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              onClick={props.onLong}
              disabled={!props.canLong}
              class={actionButton(props.canLong, "green")}
            >
              <TrendingUp size={16} />
              Long
            </button>
            <button
              onClick={props.onShort}
              disabled={!props.canShort}
              class={actionButton(props.canShort, "rose")}
            >
              <TrendingDown size={16} />
              Short
            </button>
            <button
              onClick={props.onExit}
              disabled={!props.canExitPosition}
              class={ghostButton(props.canExitPosition)}
            >
              <DoorOpen size={16} />
              Exit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
