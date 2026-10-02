import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspacePanel,
  normalizeWorkspaceState,
} from "../src/components/workspace/chartPanelTypes.ts";

test("normalizeWorkspaceState trims legacy workspace panel counts", () => {
  const legacyState = normalizeWorkspaceState({
    selectedPreset: "grid",
    presets: {
      focus: {
        panels: [createWorkspacePanel("focus", 0)],
        layout: {
          kind: "focus",
          rowWeights: [1],
        },
      },
      split: {
        panels: [
          createWorkspacePanel("split", 0),
          createWorkspacePanel("split", 1),
          createWorkspacePanel("split", 2),
        ],
        layout: {
          kind: "split",
          rowWeights: [1, 1],
          columnRatios: [0.55, 0.45],
        },
      },
      grid: {
        panels: [
          createWorkspacePanel("grid", 0),
          createWorkspacePanel("grid", 1),
          createWorkspacePanel("grid", 2),
          createWorkspacePanel("grid", 3),
          createWorkspacePanel("grid", 4),
          createWorkspacePanel("grid", 5),
        ],
        layout: {
          kind: "grid",
          rowWeights: [1, 1, 1],
          columnRatios: [0.5, 0.5, 0.5],
        },
      },
    },
  });

  assert.equal(legacyState.presets.focus.panels.length, 1);
  assert.equal(legacyState.presets.split.panels.length, 2);
  assert.equal(legacyState.presets.grid.panels.length, 4);
  assert.equal(legacyState.presets.split.layout.rowWeights.length, 1);
  assert.equal(legacyState.presets.grid.layout.rowWeights.length, 2);
  assert.equal(legacyState.presets.grid.panels.at(-1)?.title, "ES 4h");
});
