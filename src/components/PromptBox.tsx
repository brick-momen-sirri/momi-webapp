import { useState } from "react";
import { Camera, Eraser, FileText, Sparkle, Wand2 } from "lucide-react";
import { describeUploadedImages, generateKlingPromptWithWorkflow, generateSeedancePromptWithWorkflow, improvePromptWithQwen } from "../services/promptApi";
import { isKlingWorkflowModel, isSeedanceWorkflowModel, KLING_PROMPT_CHARACTER_LIMIT } from "../services/promptRules";
import type { ModelType, UploadedImage } from "../types";

type PromptBoxProps = {
  value: string;
  onChange: (value: string) => void;
  images: UploadedImage[];
  selectedModel: ModelType;
};

const movementActions = {
  Linear: ["Push In", "Push Out", "Track Left-to-Right", "Track Right-to-Left", "Pan Left", "Pan Right", "Tilt Up", "Tilt Down", "Boom Up", "Boom Down"],
  Orbit: ["90-Degree Arc", "180-Degree Semi-Circle", "360-Degree Full Orbit", "Spiral In", "Spiral Out", "Continuous Orbit (Loop)"],
  Combined: ["Spiral Reveal", "Crane Orbit Reveal", "Parallax Push-In", "Diagonal Track and Pan", "Dolly Zoom"],
  Static: ["One-Point Perspective", "Macro Close-up", "Locked-Off Wide Shot", "Detail Framing"],
} as const;

type MovementStyle = keyof typeof movementActions;

const speedModifiers = ["Extremely slow and cinematic", "Slow and smooth", "Moderate tracking speed", "Dynamic"];
const subjectPresets = ["Custom", "building facade", "kitchen island", "living room space", "entry lobby", "staircase", "courtyard", "material texture", "window detail", "landscape approach"];

const movementStylePrompts: Record<MovementStyle, string> = {
  Linear: "linear camera movement style",
  Orbit: "orbital camera movement style",
  Combined: "cinematic combined camera movement style",
  Static: "locked-off architectural framing style",
};

const cameraActionTemplates: Record<string, string> = {
  "Push In": "{speed_modifier} forward dolly shot pushing directly toward the {target_subject}",
  "Push Out": "{speed_modifier} camera pull-back establishing the scale of the {target_subject}",
  "Track Left-to-Right": "{speed_modifier} lateral tracking shot moving from left to right parallel to the {target_subject}",
  "Track Right-to-Left": "{speed_modifier} lateral tracking shot moving from right to left parallel to the {target_subject}",
  "Pan Left": "{speed_modifier} controlled pan left scanning across the {target_subject}",
  "Pan Right": "{speed_modifier} controlled pan right scanning across the {target_subject}",
  "Tilt Up": "{speed_modifier} vertical tilt-up starting from the base of the {target_subject}",
  "Tilt Down": "{speed_modifier} vertical tilt-down revealing the upper volume of {target_subject}",
  "Boom Up": "{speed_modifier} vertical boom shot rising smoothly along the Z-axis of the {target_subject}",
  "Boom Down": "{speed_modifier} vertical crane shot descending to establish a human eye-level view of the {target_subject}",
  "90-Degree Arc": "{speed_modifier} 90-degree smooth arc move around the {target_subject}",
  "180-Degree Semi-Circle": "{speed_modifier} 180-degree semi-circle orbit around the {target_subject}",
  "360-Degree Full Orbit": "{speed_modifier} complete 360-degree full orbit around the {target_subject}",
  "Spiral In": "{speed_modifier} inward spiral orbit gradually closing distance to the {target_subject}",
  "Spiral Out": "{speed_modifier} outward spiral orbit gradually revealing the surrounding space around the {target_subject}",
  "Continuous Orbit (Loop)": "{speed_modifier} continuous looping orbit around the {target_subject}",
  "Spiral Reveal": "{speed_modifier} rising crane shot while simultaneously orbiting the {target_subject}",
  "Crane Orbit Reveal": "{speed_modifier} crane-up reveal combined with a smooth orbit around the {target_subject}",
  "Parallax Push-In": "{speed_modifier} forward push-in with subtle lateral parallax across the {target_subject}",
  "Diagonal Track and Pan": "{speed_modifier} diagonal tracking move with a coordinated pan across the {target_subject}",
  "Dolly Zoom": "{speed_modifier} architectural dolly zoom maintaining focus on the {target_subject}",
  "One-Point Perspective": "Static tripod shot with precise one-point perspective centered on the {target_subject}, zero camera movement",
  "Macro Close-up": "Fixed macro close-up shot focusing deeply on the texture and intricate details of the {target_subject}",
  "Locked-Off Wide Shot": "Static locked-off wide architectural shot framing the {target_subject}, zero camera movement",
  "Detail Framing": "Static detailed composition isolating the architectural form and surface qualities of the {target_subject}, zero camera movement",
};

export function PromptBox({ value, onChange, images, selectedModel }: PromptBoxProps) {
  const [isDescribing, setIsDescribing] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const [movementStyle, setMovementStyle] = useState<MovementStyle>("Linear");
  const [actionType, setActionType] = useState("Push In");
  const [speedModifier, setSpeedModifier] = useState("Slow and smooth");
  const [lockTargetSubject, setLockTargetSubject] = useState(false);
  const [stabilityReinforcement, setStabilityReinforcement] = useState(true);
  const [cameraHelperEnabled, setCameraHelperEnabled] = useState(false);
  const [targetSubjectPreset, setTargetSubjectPreset] = useState("Custom");
  const [targetSubject, setTargetSubject] = useState("[Subject]");
  const promptMode = promptModeForModel(selectedModel);
  const isVideoWorkflow = selectedModel.category === "video";
  const isKlingWorkflow = isKlingWorkflowModel(selectedModel);
  const isSeedanceWorkflow = isSeedanceWorkflowModel(selectedModel);
  const isKlingPromptTooLong = isKlingWorkflow && value.length > KLING_PROMPT_CHARACTER_LIMIT;
  const usesCameraHelper = isVideoWorkflow && !isSeedanceWorkflow;
  const shouldUseCameraHelper = usesCameraHelper && cameraHelperEnabled;
  const isImageEditingWorkflow = !isVideoWorkflow;
  const availableActions = movementActions[movementStyle];

  function appendPrompt(text: string) {
    onChange(value.trim() ? `${value.trim()}\n${text}` : text);
  }

  async function describeImage() {
    const image = images.find(Boolean);
    if (!image) {
      setDescriptionError("Upload an image first.");
      return;
    }

    setIsDescribing(true);
    setDescriptionError("");
    try {
      if (isSeedanceWorkflow) {
        const seedancePrompt = await generateSeedancePromptWithWorkflow(images, {
          userPrompt: value,
        });
        onChange(seedancePrompt);
        return;
      }

      const cameraPrompt = shouldUseCameraHelper
        ? buildCameraPrompt({
            movementStyle,
            actionType,
            speedModifier,
            lockTargetSubject,
            stabilityReinforcement,
            targetSubjectPreset,
            targetSubject,
            compact: isKlingWorkflow,
          })
        : undefined;
      if (isKlingWorkflow) {
        const klingPrompt = await generateKlingPromptWithWorkflow(images, {
          userPrompt: value,
          cameraPrompt,
        });
        onChange(klingPrompt);
        return;
      }

      const description = await describeUploadedImages(images, {
        mode: promptMode,
        userPrompt: value,
        cameraPrompt,
      });
      if (isVideoWorkflow) {
        onChange(description);
      } else {
        appendPrompt(`Image description:\n${description}`);
      }
    } catch (error) {
      setDescriptionError(error instanceof Error ? error.message : "Could not describe image.");
    } finally {
      setIsDescribing(false);
    }
  }

  async function improvePrompt() {
    setIsImproving(true);
    setDescriptionError("");
    try {
      const cameraPrompt = shouldUseCameraHelper
        ? buildCameraPrompt({
            movementStyle,
            actionType,
            speedModifier,
            lockTargetSubject,
            stabilityReinforcement,
            targetSubjectPreset,
            targetSubject,
            compact: isKlingWorkflow,
          })
        : undefined;
      const improved = await improvePromptWithQwen({
        text: value,
        images,
        mode: isVideoWorkflow ? videoPromptMode(promptMode) : "imageEditing",
        cameraPrompt,
      });
      onChange(improved);
    } catch (error) {
      setDescriptionError(error instanceof Error ? error.message : "Could not improve prompt.");
    } finally {
      setIsImproving(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Prompt</h2>
        </div>
        <button
          type="button"
          onClick={() => onChange("")}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-500 transition hover:bg-stone-50"
          title="Clear prompt"
        >
          <Eraser className="h-4 w-4" />
        </button>
      </div>

      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Describe the generation you want..."
        aria-invalid={isKlingPromptTooLong}
        aria-describedby={isKlingWorkflow ? "kling-prompt-length" : undefined}
        className={`min-h-32 w-full resize-none rounded-md border bg-white p-3 text-sm leading-6 outline-none transition placeholder:text-stone-400 focus:ring-2 ${
          isKlingPromptTooLong
            ? "border-red-400 focus:border-red-500 focus:ring-red-200"
            : "border-line focus:border-accent focus:ring-accent/20"
        }`}
      />

      {isKlingWorkflow ? (
        <div id="kling-prompt-length" className="mt-2">
          <p className={`text-right text-xs font-semibold ${isKlingPromptTooLong ? "text-red-600" : "text-stone-500"}`}>
            {value.length.toLocaleString()} / {KLING_PROMPT_CHARACTER_LIMIT.toLocaleString()} characters
          </p>
          {isKlingPromptTooLong ? (
            <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-700">
              Kling accepts a maximum of {KLING_PROMPT_CHARACTER_LIMIT.toLocaleString()} characters. Shorten this prompt by {(value.length - KLING_PROMPT_CHARACTER_LIMIT).toLocaleString()} characters before generating.
            </p>
          ) : null}
        </div>
      ) : null}

      {usesCameraHelper ? (
        <div className="mt-3 rounded-md border border-line bg-stone-50 p-2">
          <div className={`flex items-center justify-between gap-3 ${cameraHelperEnabled ? "mb-2" : ""}`}>
            <div className="flex items-center gap-2">
              <Camera className="h-3.5 w-3.5 text-stone-500" />
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Camera</p>
            </div>
            <label className="flex items-center gap-2 text-xs font-semibold text-stone-600" title="Enable or disable camera instructions in prompt generation">
              <input
                type="checkbox"
                checked={cameraHelperEnabled}
                onChange={(event) => setCameraHelperEnabled(event.target.checked)}
                aria-controls="camera-helper-controls"
                aria-expanded={cameraHelperEnabled}
                className="accent-accent"
              />
              Enabled
            </label>
          </div>
          {cameraHelperEnabled ? (
            <div id="camera-helper-controls">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={movementStyle}
                  onChange={(event) => {
                    const nextStyle = event.target.value as MovementStyle;
                    setMovementStyle(nextStyle);
                    setActionType(movementActions[nextStyle][0]);
                  }}
                  className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {Object.keys(movementActions).map((style) => (
                    <option key={style} value={style}>
                      {style}
                    </option>
                  ))}
                </select>
                <select
                  value={actionType}
                  onChange={(event) => setActionType(event.target.value)}
                  className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {availableActions.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
                <select
                  value={speedModifier}
                  onChange={(event) => setSpeedModifier(event.target.value)}
                  className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {speedModifiers.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}
                    </option>
                  ))}
                </select>
                {lockTargetSubject ? (
                  <select
                    value={targetSubjectPreset}
                    onChange={(event) => setTargetSubjectPreset(event.target.value)}
                    className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    {subjectPresets.map((subject) => (
                      <option key={subject} value={subject}>
                        {subject}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex h-9 items-center rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-400">
                    Custom disabled
                  </div>
                )}
                {targetSubjectPreset === "Custom" && lockTargetSubject ? (
                  <input
                    value={targetSubject}
                    onChange={(event) => setTargetSubject(event.target.value)}
                    className="col-span-2 h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
                    placeholder="[Subject]"
                  />
                ) : null}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex min-h-8 items-center gap-2 rounded-md bg-white px-2 text-xs font-semibold text-stone-600">
                  <input
                    type="checkbox"
                    checked={lockTargetSubject}
                    onChange={(event) => setLockTargetSubject(event.target.checked)}
                    className="accent-accent"
                  />
                  Lock subject
                </label>
                <label className="flex min-h-8 items-center gap-2 rounded-md bg-white px-2 text-xs font-semibold text-stone-600">
                  <input
                    type="checkbox"
                    checked={stabilityReinforcement}
                    onChange={(event) => setStabilityReinforcement(event.target.checked)}
                    className="accent-accent"
                  />
                  Stable motion
                </label>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={`mt-3 grid gap-2 ${isVideoWorkflow ? "grid-cols-2" : "grid-cols-1"}`}>
        {isVideoWorkflow ? (
          <button
            type="button"
            onClick={() => void describeImage()}
            disabled={isDescribing}
            className="flex min-h-10 items-center justify-center gap-2 rounded-md border border-line bg-stone-50 px-3 text-xs font-semibold text-stone-700 transition hover:bg-white disabled:cursor-wait disabled:opacity-60"
          >
            <Sparkle className="h-3.5 w-3.5 text-accent" />
            {isDescribing ? "Generating..." : isSeedanceWorkflow ? "Generate Seedance prompt" : isKlingWorkflow ? "Generate Kling prompt" : "Generate video prompt"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void improvePrompt()}
          disabled={isImproving}
          className="flex min-h-10 items-center justify-center gap-2 rounded-md border border-line bg-stone-50 px-3 text-xs font-semibold text-stone-700 transition hover:bg-white disabled:cursor-wait disabled:opacity-60"
        >
          <Wand2 className="h-3.5 w-3.5 text-ember" />
          {isImproving ? "Improving..." : isImageEditingWorkflow ? "Improve this prompt" : "Improve prompt"}
        </button>
      </div>
      {descriptionError ? (
        <p className="mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {descriptionError}
        </p>
      ) : null}
    </section>
  );
}

function videoPromptMode(mode: "generic" | "video" | "klingVideo" | "seedanceVideo") {
  if (mode === "klingVideo") return "klingVideo";
  if (mode === "seedanceVideo") return "seedanceVideo";
  return "video";
}

function buildCameraPrompt({
  movementStyle,
  actionType,
  speedModifier,
  lockTargetSubject,
  stabilityReinforcement,
  targetSubjectPreset,
  targetSubject,
  compact,
}: {
  movementStyle: MovementStyle;
  actionType: string;
  speedModifier: string;
  lockTargetSubject: boolean;
  stabilityReinforcement: boolean;
  targetSubjectPreset: string;
  targetSubject: string;
  compact: boolean;
}) {
  const allowedActions = movementActions[movementStyle];
  const cleanAction = allowedActions.includes(actionType as never) ? actionType : allowedActions[0];
  const cleanSubject = lockTargetSubject
    ? targetSubjectPreset === "Custom"
      ? targetSubject.trim() || "[Subject]"
      : targetSubjectPreset
    : "the architectural space";

  const template = cameraActionTemplates[cleanAction];
  let cameraPrompt = template
    .replace("{speed_modifier}", speedModifier)
    .replaceAll("{target_subject}", cleanSubject);

  cameraPrompt = `${cameraPrompt}, using a ${movementStylePrompts[movementStyle]}`;

  if (!lockTargetSubject) {
    cameraPrompt += ", moving freely without locking onto a single subject";
  }

  if (stabilityReinforcement) {
    cameraPrompt += ", maintaining absolute camera stability, perfectly smooth motion curves, and zero organic handheld shaking.";
  }

  if (!compact || cameraPrompt.length <= 350) {
    return cameraPrompt;
  }

  return cameraPrompt.slice(0, 350).trim().replace(/[.,;:]+$/, "");
}

function promptModeForModel(model: ModelType) {
  if (model.category !== "video") {
    return "generic";
  }

  if (isKlingWorkflowModel(model)) return "klingVideo";
  if (isSeedanceWorkflowModel(model)) return "seedanceVideo";
  return "video";
}
