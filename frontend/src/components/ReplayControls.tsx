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

interface ChartStripProps {
  isPlaying: boolean;
  statusLabel: string;
  currentBar: number;
  totalBars: number;
  currentPriceLabel: string;
  bidAskLabel: string;
  canStartPlayback: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
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

function ghostButton(enabled: boolean): string {
  return [
    "flex items-center gap-2 rounded-sm border px-3 py-2 text-sm transition-colors",
    enabled
      ? "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800"
      : "cursor-not-allowed border-zinc-800 bg-zinc-950 text-zinc-600",
  ].join(" ");
}

function actionButton(enabled: boolean, tone: "green" | "rose"): string {
  const activeTone =
    tone === "green"
      ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
      : "bg-rose-500 text-white hover:bg-rose-400";

  return [
    "flex items-center gap-2 rounded-sm px-4 py-2 text-sm font-medium transition-colors",
    enabled ? activeTone : "cursor-not-allowed bg-zinc-800 text-zinc-500",
  ].join(" ");
}

export function ReplayChartStrip(props: ChartStripProps) {
  const playEnabled = () => props.isPlaying || props.canStartPlayback;

  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-zinc-700/80 bg-zinc-950/78 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="app-panel-selected rounded-sm border px-3 py-1.5 font-semibold uppercase tracking-[0.16em] text-sky-100">
          {props.statusLabel}
        </span>
        <span class="rounded-sm border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-zinc-400">
          Bar <span class="app-data ml-1 text-zinc-100">{props.currentBar} / {props.totalBars}</span>
        </span>
        <span class="rounded-sm border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-zinc-400">
          Last <span class="app-data ml-1 text-zinc-100">{props.currentPriceLabel}</span>
        </span>
        <span class="rounded-sm border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-zinc-400">
          Book <span class="app-data ml-1 text-zinc-100">{props.bidAskLabel}</span>
        </span>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <button
          onClick={props.onPlayPause}
          disabled={!playEnabled()}
          class={`flex items-center gap-2 rounded-sm px-5 py-2 text-sm font-semibold transition-colors ${
            playEnabled()
              ? "bg-sky-400 text-zinc-950 hover:bg-sky-300"
              : "cursor-not-allowed bg-zinc-800 text-zinc-500"
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
          class="flex items-center gap-2 rounded-sm border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
        >
          <RotateCw size={14} />
          Restart
        </button>
      </div>
    </div>
  );
}

export function ReplayExecutionActions(props: ExecutionActionsProps) {
  return (
    <div class="flex flex-wrap items-center gap-2 border-t border-zinc-700/80 bg-zinc-950/78 px-4 py-3">
      <span class="mr-1 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
        <TrendingUp size={14} />
        Execute
      </span>
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
      <div class="border-b border-zinc-700/80 bg-zinc-950/78 px-5 py-3">
        <p class="text-xs uppercase tracking-[0.18em] text-sky-300">Session Control</p>
        <p class="mt-1 text-sm text-zinc-500">{props.statusDetail}</p>
      </div>

      <div class="space-y-5 p-5">
        <div class="grid gap-2 md:grid-cols-3">
          <div class="rounded-sm border border-zinc-700/80 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
            <p>Time</p>
            <p class="app-data mt-1 text-sm text-zinc-200">{props.currentTimeLabel}</p>
          </div>
          <div class="rounded-sm border border-zinc-700/80 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
            <p>Position</p>
            <p class="app-data mt-1 text-sm text-zinc-200">{props.positionLabel}</p>
          </div>
          <div class="rounded-sm border border-zinc-700/80 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
            <p>Resting Order</p>
            <p class="app-data mt-1 text-sm text-zinc-200">{props.activeOrderLabel}</p>
          </div>
        </div>

        <div class="rounded-md border border-zinc-700/80 bg-zinc-950/80 p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
              <CircleDot size={16} />
              Timeline
            </div>
            <div class="rounded-sm border border-zinc-700/80 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-400">
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
              <span class="app-data text-zinc-300">
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
          <div class="rounded-md border border-zinc-700/80 bg-zinc-950/80 p-4">
            <div class="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
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
                      ? "app-card-selected border-sky-400/80 font-semibold text-sky-100"
                      : "border-zinc-800 bg-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-700"
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>

          <div class="rounded-md border border-zinc-700/80 bg-zinc-950/80 p-4">
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
          statusLabel={props.statusLabel}
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
