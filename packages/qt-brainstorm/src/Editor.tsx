/**
 * The `brainstorm` editor: the question and how many ideas a participant
 * may hold. There is no key to write.
 */
import type { EditorProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { BRAINSTORM_MAX_IDEAS } from "@quiz/domain";
import { hint, NumberField, PromptField, sectionClass } from "@quiz/ui";

import type { BrainstormConfig } from "./schema.js";
import { brainstormEditorStrings, type BrainstormEditorStringKey } from "./strings.js";

type BrainstormEditorProps = EditorProps<BrainstormConfig> & {
  strings?: StringOverrides<BrainstormEditorStringKey>;
};

export function BrainstormEditor({ config, onChange, uploadAsset, disabled, RichText, strings }: BrainstormEditorProps) {
  const s = resolveStrings(brainstormEditorStrings, strings);
  return (
    <div className="flex flex-col gap-5">
      <section className={sectionClass}>
        <PromptField
          id="brainstorm-prompt"
          label={s.prompt}
          value={config.prompt}
          onChange={(prompt) => onChange({ ...config, prompt })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
          rows={2}
        />
      </section>
      <section className={sectionClass}>
        <NumberField
          id="brainstorm-max"
          label={s.maxIdeas}
          value={config.maxIdeas}
          min={1}
          max={BRAINSTORM_MAX_IDEAS}
          step={1}
          disabled={disabled}
          onChange={(maxIdeas) =>
            onChange({ ...config, maxIdeas: Math.min(BRAINSTORM_MAX_IDEAS, Math.max(1, Math.round(maxIdeas))) })
          }
        />
        <p className={hint}>{s.maxIdeasHint}</p>
      </section>
    </div>
  );
}
