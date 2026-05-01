import {
  ArrowLeft,
  ArrowRight,
  Ban,
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
  bidAskLabel: string;
  positionLabel: string;
  activeOrderLabel: string;
  canSeek: boolean;
  canStartPlayback: boolean;
  canStepBack: boolean;
  canStepForward: boolean;
  canJumpPrevTrade: boolean;
  canJumpNextTrade: boolean;
  canLiftAsk: boolean;
  canHitBid: boolean;
  canJoinBid: boolean;
  canJoinAsk: boolean;
  canCancelOrder: boolean;
  canFlatten: boolean;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (progress: number) => void;
  onRestart: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onJumpPrevTrade: () => void;
  onJumpNextTrade: () => void;
  onLiftAsk: () => void;
  onHitBid: () => void;
  onJoinBid: () => void;
  onJoinAsk: () => void;
  onCancel: () => void;
  onFlatten: () => void;
}

const speeds = [1, 2, 5, 8, 12, 20];

function ghostButton(enabled: boolean): string {
  return [
    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
    enabled
      ? "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
      : "cursor-not-allowed border-zinc-800 bg-zinc-950 text-zinc-600",
  ].join(" ");
}

function actionButton(enabled: boolean, tone: "green" | "rose"): string {
  const activeTone =
    tone === "green"
      ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
      : "bg-rose-500 text-white hover:bg-rose-400";

  return [
    "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
    enabled ? activeTone : "cursor-not-allowed bg-zinc-800 text-zinc-500",
  ].join(" ");
}

export default function ReplayControls(props: Props) {
  return (
    <div class="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/90">
      <div class="border-b border-zinc-800 bg-zinc-950/70 px-5 py-4">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div class="space-y-1">
            <p class="text-xs uppercase tracking-[0.18em] text-sky-300">Replay Controls</p>
            <p class="text-sm text-zinc-400">{props.statusDetail}</p>
          </div>

          <div class="flex flex-wrap gap-3">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-500">
              <p>Status</p>
              <p class="mt-1 text-sm font-semibold text-zinc-100">{props.statusLabel}</p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-500">
              <p>Current Bar</p>
              <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                {props.currentBar} / {props.totalBars}
              </p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-500">
              <p>Last Price</p>
              <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                {props.currentPriceLabel}
              </p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-500">
              <p>Book</p>
              <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                {props.bidAskLabel}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="space-y-5 p-5">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="flex flex-wrap gap-3">
            <button
              onClick={props.onPlayPause}
              disabled={!props.isPlaying && !props.canStartPlayback}
              class={`flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold transition-colors ${
                props.isPlaying || props.canStartPlayback
                  ? "bg-sky-400 text-zinc-950 hover:bg-sky-300"
                  : "cursor-not-allowed bg-zinc-800 text-zinc-500"
              }`}
            >
              {props.isPlaying ? (
                <>
                  <Pause size={20} /> Pause Tape
                </>
              ) : (
                <>
                  <Play size={20} fill="currentColor" /> Play Replay
                </>
              )}
            </button>

            <button
              onClick={props.onRestart}
              class="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
            >
              <RotateCw size={18} />
              Restart
            </button>
          </div>

          <div class="grid min-w-72 grid-cols-1 gap-2 md:grid-cols-2 xl:max-w-[440px]">
            <div class="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
              <p>Time</p>
              <p class="mt-1 font-mono text-sm text-zinc-200">{props.currentTimeLabel}</p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
              <p>Position</p>
              <p class="mt-1 font-mono text-sm text-zinc-200">{props.positionLabel}</p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-500 md:col-span-2">
              <p>Resting Order</p>
              <p class="mt-1 font-mono text-sm text-zinc-200">{props.activeOrderLabel}</p>
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
              <CircleDot size={16} />
              Timeline
            </div>
            <div class="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-400">
              {Math.round(props.progress * 100)}% complete
            </div>
          </div>

          <div class="mt-4 space-y-3">
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={props.progress}
              disabled={!props.canSeek}
              onInput={(event) => props.onSeek(parseFloat(event.currentTarget.value))}
              class="w-full accent-sky-400"
            />
            <div class="flex justify-between text-xs text-zinc-500">
              <span>Opening bar</span>
              <span class="font-mono text-zinc-300">
                {props.currentBar} / {props.totalBars}
              </span>
              <span>Latest visible bar</span>
            </div>
            {props.canSeek ? (
              <p class="text-xs text-zinc-500">
                Review mode: scrubbing is enabled.
              </p>
            ) : (
              <p class="text-xs text-zinc-500">
                Timeline locked until review.
              </p>
            )}
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div class="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
              <Gauge size={16} />
              Speed
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              {speeds.map((speed) => (
                <button
                  onClick={() => props.onSpeedChange(speed)}
                  disabled={!props.canStartPlayback && !props.isPlaying}
                  class={`rounded-lg px-4 py-2 text-sm transition-colors ${
                    props.speed === speed
                      ? "bg-sky-400 font-semibold text-zinc-950"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>

          <div class="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
              <ArrowLeft size={16} />
              Navigation
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
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
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
          <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
            <TrendingUp size={16} />
            Execution Actions
          </div>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              onClick={props.onLiftAsk}
              disabled={!props.canLiftAsk}
              class={actionButton(props.canLiftAsk, "green")}
            >
              <TrendingUp size={16} />
              Lift Ask
            </button>
            <button
              onClick={props.onHitBid}
              disabled={!props.canHitBid}
              class={actionButton(props.canHitBid, "rose")}
            >
              <TrendingDown size={16} />
              Hit Bid
            </button>
            <button
              onClick={props.onJoinBid}
              disabled={!props.canJoinBid}
              class={ghostButton(props.canJoinBid)}
            >
              <CircleDot size={16} />
              Join Bid
            </button>
            <button
              onClick={props.onJoinAsk}
              disabled={!props.canJoinAsk}
              class={ghostButton(props.canJoinAsk)}
            >
              <CircleDot size={16} />
              Join Ask
            </button>
            <button
              onClick={props.onCancel}
              disabled={!props.canCancelOrder}
              class={ghostButton(props.canCancelOrder)}
            >
              <Ban size={16} />
              Cancel
            </button>
            <button
              onClick={props.onFlatten}
              disabled={!props.canFlatten}
              class={ghostButton(props.canFlatten)}
            >
              <DoorOpen size={16} />
              Flatten
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
