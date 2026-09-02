import type { EmailAttachmentInput } from "./message.js";

/** What a template renders for one data value. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly attachments?: ReadonlyArray<EmailAttachmentInput>;
}

/**
 * A typed transactional email: one render function from typed data to a
 * complete body, plus canonical preview data for the dev preview wall.
 * Templates carry a stable name — the only identifying value logged or
 * measured per email (never subject, never body).
 */
export interface EmailTemplate<in out T> {
  readonly name: string;
  readonly render: (data: T) => RenderedEmail;
  readonly preview: T;
}

export const defineEmailTemplate = <T>(
  name: string,
  render: (data: T) => RenderedEmail,
  preview: T,
): EmailTemplate<T> => ({ name, render, preview });

/**
 * A template closed over its own preview data — the type-erased form a
 * preview wall can hold in one list regardless of each template's data type.
 */
export interface TemplatePreviewEntry {
  readonly name: string;
  /** The canonical preview data (typed at the definition site). */
  readonly data: unknown;
  readonly render: () => RenderedEmail;
}

/** Captures a template with its preview data into an erasable entry. */
export const previewEntry = <T>(template: EmailTemplate<T>): TemplatePreviewEntry => ({
  name: template.name,
  data: template.preview,
  render: () => template.render(template.preview),
});

export interface TemplatePreview {
  readonly name: string;
  readonly data: unknown;
  readonly rendered: RenderedEmail;
}

/**
 * Renders every entry's preview — the payload for a dev preview wall (an
 * HTTP route or a CLI dump). Previews render with production code, so what
 * you see is what subscribers get.
 */
export const renderPreviews = (
  entries: ReadonlyArray<TemplatePreviewEntry>,
): ReadonlyArray<TemplatePreview> =>
  entries.map((entry) => ({ name: entry.name, data: entry.data, rendered: entry.render() }));
