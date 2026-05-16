import { Show } from "solid-js";
import { firmLogoSrc } from "../utils/firmLogo";

interface Props {
  firmName: string | null | undefined;
  /** Tailwind height class applied to the img, e.g. "h-5" or "h-6". Defaults to "h-5". */
  heightClass?: string;
  class?: string;
}

export default function FirmLogo(props: Props) {
  const src = () => firmLogoSrc(props.firmName);
  return (
    <Show when={src()}>
      {(logoSrc) => (
        <img
          src={logoSrc()}
          alt={props.firmName ?? ""}
          class={`inline-block object-contain ${props.heightClass ?? "h-5"} ${props.class ?? ""}`}
        />
      )}
    </Show>
  );
}
