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
  TrendingUp,
} from "lucide-solid";
import { Show } from "solid-js";

interface ChartStripProps {
  isPlaying: boolean;
  currentBar: number;
  totalBars: number;
  currentPriceLabel: string;
  bidAskLabel: string;
  canStartPlayback: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
}

interface PnLStripProps {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  isBreached: boolean;
  breachLabel?: string | null;
}

interface ExecutionActionsProps {
  canLiftAsk: boolean;
  canHitBid: boolean;
  canJoinBid: boolean;
  canJoinAsk: boolean;
  canRestExit: boolean;
  canReplaceOrder: boolean;
  canCancelOrder: boolean;
  canFlatten: boolean;
  onLiftAsk: () => void;
  onHitBid: () => void;
  onJoinBid: () => void;
  onJoinAsk: () => void;
  onRestExit: () => void;
  onReplace: () => void;
  onCancel: () => void;
  onFlatten: () => void;
}

interface TimelineControlsProps {
  speed: number;
  progress: number;
  currentBar: number;
  totalBars: number;
  statusDetail: string;
  currentTimeLabel: string;
  positionLabel: string;
  activeOrderLabel: string;
  isPlaying: boolean;
  canSeek: boolean;
  canStartPlayback: boolean;
  canStepBack: boolean;
  canStepForward: boolean;
  canJumpPrevTrade: boolean;
  canJumpNextTrade: boolean;
  onSpeedChange: (speed: number) => void;
  onSeek: (progress: number) => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onJumpPrevTrade: () => void;
  onJumpNextTrade: () => void;
}

type Props = ChartStripProps & ExecutionActionsProps & TimelineControlsProps;

const speeds = [1, 2, 5, 8, 12, 20];

function ghostButton(enabled: boolean, tone: "neutral" | "green" | "rose" = "neutral"): string {
  const activeTone =
    tone === "green"
      ? "border-green-500/50 bg-green-500/12 text-green-300 hover:border-green-400/70 hover:bg-green-500/18"
      : tone === "rose"
        ? "border-rose-500/50 bg-rose-500/12 text-rose-300 hover:border-rose-400/70 hover:bg-rose-500/18"
        : "border-stone-700 bg-stone-900 text-stone-200 hover:border-stone-600 hover:bg-stone-800";

  return [
    "flex items-center gap-2 rounded-sm border px-3 py-2 text-sm transition-colors",
    enabled ? activeTone : "cursor-not-allowed border-stone-800 bg-stone-950 text-stone-600",
  ].join(" ");
}

function actionButton(enabled: boolean, tone: "green" | "rose"): string {
  const activeTone =
    tone === "green"
      ? "bg-green-500 text-stone-950 hover:bg-green-400"
      : "bg-rose-500 text-white hover:bg-rose-400";

  return [
    "flex items-center justify-center rounded-sm px-4 py-2 text-sm font-medium transition-colors",
    enabled ? activeTone : "cursor-not-allowed bg-stone-800 text-stone-500",
  ].join(" ");
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

export function ReplayChartStrip(props: ChartStripProps) {
  const playEnabled = () => props.isPlaying || props.canStartPlayback;

  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-white/10 bg-black/88 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-sm border border-white/10 bg-[#111] px-3 py-1.5 text-stone-400">
          Bar <span class="app-data ml-1 text-stone-100">{props.currentBar} / {props.totalBars}</span>
        </span>
        <span class="rounded-sm border border-white/10 bg-[#111] px-3 py-1.5 text-stone-400">
          Last <span class="app-data ml-1 text-stone-100">{props.currentPriceLabel}</span>
        </span>
        <span class="rounded-sm border border-white/10 bg-[#111] px-3 py-1.5 text-stone-400">
          Book <span class="app-data ml-1 text-stone-100">{props.bidAskLabel}</span>
        </span>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <button
          onClick={props.onPlayPause}
          disabled={!playEnabled()}
          class={`flex items-center gap-2 rounded-sm px-5 py-2 text-sm font-semibold transition-colors ${
            playEnabled()
              ? "bg-green-400 text-stone-950 hover:bg-green-300"
              : "cursor-not-allowed bg-stone-800 text-stone-500"
          }`}
        >
          {props.isPlaying ? (
            <>
              <Pause size={16} /> Pause
            </>
          ) : (
            <>
              <Play size={16} fill="currentColor" /> Play
            </>
          )}
        </button>
        <button
          onClick={props.onRestart}
          class="flex items-center gap-2 rounded-sm border border-stone-700 px-3 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
        >
          <RotateCw size={14} />
          Restart
        </button>
      </div>
    </div>
  );
}

export function ReplayPnLStrip(props: PnLStripProps) {
  return (
    <div class="grid gap-2 border-b border-white/10 bg-black/84 px-4 py-3 text-xs md:grid-cols-3">
      <div class="rounded-sm border border-white/10 bg-[#111] px-3 py-2 text-stone-400">
        <p>Realized P&amp;L</p>
        <p class={`app-data mt-1 text-sm font-semibold ${props.realizedPnl >= 0 ? "text-green-300" : "text-rose-300"}`}>
          {formatSignedMoney(props.realizedPnl)}
        </p>
      </div>
      <div class="rounded-sm border border-white/10 bg-[#111] px-3 py-2 text-stone-400">
        <p>Open P&amp;L</p>
        <p class={`app-data mt-1 text-sm font-semibold ${props.unrealizedPnl >= 0 ? "text-green-300" : "text-rose-300"}`}>
          {formatSignedMoney(props.unrealizedPnl)}
        </p>
      </div>
      <div class="rounded-sm border border-white/10 bg-[#111] px-3 py-2 text-stone-400">
        <p class="flex items-center justify-between gap-2">
          <span>Total P&amp;L</span>
          <span class="text-stone-500">{props.isBreached ? "Locked" : "Live"}</span>
        </p>
        <p class={`app-data mt-1 text-sm font-semibold ${props.totalPnl >= 0 ? "text-green-300" : "text-rose-300"}`}>
          {formatSignedMoney(props.totalPnl)}
        </p>
        <Show when={props.isBreached}>
          <p class="mt-1 text-[11px] text-rose-300">
            {props.breachLabel ?? "Account breached. Trading is locked for this session."}
          </p>
        </Show>
      </div>
    </div>
  );
}

export function ReplayExecutionActions(props: ExecutionActionsProps) {
  return (
    <div class="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/88 px-4 py-3">
      <span class="mr-1 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-stone-500">
        <TrendingUp size={14} />
        Execute
      </span>
      <button
        onClick={props.onLiftAsk}
        disabled={!props.canLiftAsk}
        class={actionButton(props.canLiftAsk, "green")}
      >
        MKT BUY
      </button>
      <button
        onClick={props.onHitBid}
        disabled={!props.canHitBid}
        class={actionButton(props.canHitBid, "rose")}
      >
        MKT SELL
      </button>
      <button
        onClick={props.onJoinBid}
        disabled={!props.canJoinBid}
        class={ghostButton(props.canJoinBid, "green")}
      >
        <CircleDot size={16} />
        Join Bid
      </button>
      <button
        onClick={props.onJoinAsk}
        disabled={!props.canJoinAsk}
        class={ghostButton(props.canJoinAsk, "rose")}
      >
        <CircleDot size={16} />
        Join Ask
      </button>
      <button
        onClick={props.onRestExit}
        disabled={!props.canRestExit}
        class={ghostButton(props.canRestExit)}
      >
        <CircleDot size={16} />
        Rest Exit
      </button>
      <button
        onClick={props.onReplace}
        disabled={!props.canReplaceOrder}
        class={ghostButton(props.canReplaceOrder)}
      >
        <RotateCw size={16} />
        Replace
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
  );
}

export function ReplayTimelineControls(props: TimelineControlsProps) {
  return (
    <div class="app-panel overflow-hidden rounded-md">
      <div class="border-b border-white/10 bg-black/88 px-5 py-3">
        <p class="text-xs uppercase tracking-[0.18em] text-stone-200">Replay State</p>
        <p class="mt-1 text-sm text-stone-500">{props.statusDetail}</p>
      </div>

      <div class="space-y-5 p-5">
        <div class="grid gap-2 md:grid-cols-3">
          <div class="rounded-sm border border-white/10 bg-[#0d0d0d] px-3 py-3 text-xs text-stone-500">
            <p>Time</p>
            <p class="app-data mt-1 text-sm text-stone-200">{props.currentTimeLabel}</p>
          </div>
          <div class="rounded-sm border border-white/10 bg-[#0d0d0d] px-3 py-3 text-xs text-stone-500">
            <p>Position</p>
            <p class="app-data mt-1 text-sm text-stone-200">{props.positionLabel}</p>
          </div>
          <div class="rounded-sm border border-white/10 bg-[#0d0d0d] px-3 py-3 text-xs text-stone-500">
            <p>Resting Order</p>
            <p class="app-data mt-1 text-sm text-stone-200">{props.activeOrderLabel}</p>
          </div>
        </div>

        <div class="rounded-md border border-white/10 bg-[#0a0a0a]/88 p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-stone-500">
              <CircleDot size={16} />
              Timeline
            </div>
            <div class="rounded-sm border border-white/10 bg-[#111] px-3 py-1 text-xs font-medium text-stone-400">
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
              class="w-full accent-stone-200"
            />
            <div class="flex justify-between text-xs text-stone-500">
              <span>Opening bar</span>
              <span class="app-data text-stone-300">
                {props.currentBar} / {props.totalBars}
              </span>
              <span>Latest visible bar</span>
            </div>
            {props.canSeek ? (
              <p class="text-xs text-stone-500">
                Review mode: scrubbing is enabled.
              </p>
            ) : (
              <p class="text-xs text-stone-500">
                Timeline locked until review.
              </p>
            )}
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div class="rounded-md border border-white/10 bg-[#0a0a0a]/88 p-4">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-stone-500">
              <Gauge size={16} />
              Speed
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              {speeds.map((speed) => (
                <button
                  onClick={() => props.onSpeedChange(speed)}
                  disabled={!props.canStartPlayback && !props.isPlaying}
                  class={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                    props.speed === speed
                      ? "app-card-selected border-stone-200/80 font-semibold text-stone-50"
                      : "border-white/10 bg-[#111] text-stone-300 hover:border-white/18 hover:bg-[#171717]"
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>

          <div class="rounded-md border border-white/10 bg-[#0a0a0a]/88 p-4">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-stone-500">
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
      </div>
    </div>
  );
}

export default function ReplayControls(props: Props) {
  return (
    <div class="space-y-4">
      <div class="app-panel overflow-hidden rounded-md">
        <ReplayChartStrip
          isPlaying={props.isPlaying}
          currentBar={props.currentBar}
          totalBars={props.totalBars}
          currentPriceLabel={props.currentPriceLabel}
          bidAskLabel={props.bidAskLabel}
          canStartPlayback={props.canStartPlayback}
          onPlayPause={props.onPlayPause}
          onRestart={props.onRestart}
        />
        <ReplayExecutionActions
          canLiftAsk={props.canLiftAsk}
          canHitBid={props.canHitBid}
          canJoinBid={props.canJoinBid}
          canJoinAsk={props.canJoinAsk}
          canRestExit={props.canRestExit}
          canReplaceOrder={props.canReplaceOrder}
          canCancelOrder={props.canCancelOrder}
          canFlatten={props.canFlatten}
          onLiftAsk={props.onLiftAsk}
          onHitBid={props.onHitBid}
          onJoinBid={props.onJoinBid}
          onJoinAsk={props.onJoinAsk}
          onRestExit={props.onRestExit}
          onReplace={props.onReplace}
          onCancel={props.onCancel}
          onFlatten={props.onFlatten}
        />
      </div>
      <ReplayTimelineControls
        speed={props.speed}
        progress={props.progress}
        currentBar={props.currentBar}
        totalBars={props.totalBars}
        statusDetail={props.statusDetail}
        currentTimeLabel={props.currentTimeLabel}
        positionLabel={props.positionLabel}
        activeOrderLabel={props.activeOrderLabel}
        isPlaying={props.isPlaying}
        canSeek={props.canSeek}
        canStartPlayback={props.canStartPlayback}
        canStepBack={props.canStepBack}
        canStepForward={props.canStepForward}
        canJumpPrevTrade={props.canJumpPrevTrade}
        canJumpNextTrade={props.canJumpNextTrade}
        onSpeedChange={props.onSpeedChange}
        onSeek={props.onSeek}
        onStepBack={props.onStepBack}
        onStepForward={props.onStepForward}
        onJumpPrevTrade={props.onJumpPrevTrade}
        onJumpNextTrade={props.onJumpNextTrade}
      />
    </div>
  );
}
