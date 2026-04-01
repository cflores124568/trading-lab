import { Play, Pause, RotateCw, Gauge } from 'lucide-solid';

interface Props {
  isPlaying: boolean;
  speed: number;
  progress: number;           // 0 to 1
  currentBar: number;
  totalBars: number;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (progress: number) => void;
  onRestart: () => void;
}

const speeds = [1, 2, 5, 8, 12, 20];

export default function ReplayControls(props: Props) {
  return (
    <div class="flex flex-col gap-4 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex items-center justify-between">
        <button
          onClick={props.onPlayPause}
          class="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-medium flex items-center gap-2 transition-colors"
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

      {/* Progress */}
      <div class="space-y-2">
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={props.progress}
          onInput={(e) => props.onSeek(parseFloat(e.currentTarget.value))}
          class="w-full accent-emerald-500"
        />
        <div class="flex justify-between text-xs text-zinc-500">
          <span>Bar {props.currentBar} / {props.totalBars}</span>
          <span>{Math.round(props.progress * 100)}%</span>
        </div>
      </div>

      {/* Speed */}
      <div>
        <div class="flex items-center gap-2 text-xs text-zinc-500 mb-2">
          <Gauge size={16} />
          SPEED
        </div>
        <div class="flex gap-2 flex-wrap">
          {speeds.map((s) => (
            <button
              onClick={() => props.onSpeedChange(s)}
              class={`px-4 py-1.5 rounded-lg text-sm transition-all flex items-center gap-1 ${
                props.speed === s 
                  ? "bg-emerald-600 text-white" 
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}