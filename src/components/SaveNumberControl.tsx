import type { ModelType } from "../types";
import { ResultNamingControl } from "./ResultNamingControl";

type SaveNumberControlProps = {
  selectedModel: ModelType;
  value: string;
  onChange: (value: string) => void;
};

export function SaveNumberControl({ selectedModel, value, onChange }: SaveNumberControlProps) {
  const label = selectedModel.category === "video" ? "Shot number" : "Camera number";
  return <ResultNamingControl label={label} value={value} onChange={onChange} />;
}
