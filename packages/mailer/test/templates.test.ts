import { describe, expect, test } from "bun:test";
import { defineEmailTemplate, previewEntry, renderPreviews } from "../src/index.js";

interface InviteData {
  readonly tenant: string;
  readonly url: string;
}

const invite = defineEmailTemplate<InviteData>(
  "invite",
  (data) => ({
    subject: `You are invited to ${data.tenant}`,
    html: `<p>Join <strong>${data.tenant}</strong>: ${data.url}</p>`,
    text: `Join ${data.tenant}: ${data.url}`,
  }),
  { tenant: "Acme", url: "https://app.example.com/invite/token" },
);

describe("email templates", () => {
  test("renders subject, html and text from one typed definition", () => {
    const rendered = invite.render({ tenant: "Globex", url: "https://x.example.com/i/1" });
    expect(rendered.subject).toBe("You are invited to Globex");
    expect(rendered.html).toContain("Globex");
    expect(rendered.text).toContain("https://x.example.com/i/1");
  });

  test("preview entries render the canonical preview data", () => {
    const previews = renderPreviews([previewEntry(invite)]);
    expect(previews).toHaveLength(1);
    const preview = previews[0];
    expect(preview?.name).toBe("invite");
    expect(preview?.data).toEqual({ tenant: "Acme", url: "https://app.example.com/invite/token" });
    expect(preview?.rendered.subject).toBe("You are invited to Acme");
  });

  test("heterogeneous templates share one preview wall list", () => {
    const digest = defineEmailTemplate<{ readonly count: number }>(
      "digest",
      (data) => ({ subject: `${data.count} events`, text: `${data.count} events happened` }),
      { count: 3 },
    );
    const previews = renderPreviews([previewEntry(invite), previewEntry(digest)]);
    expect(previews.map((entry) => entry.name)).toEqual(["invite", "digest"]);
  });
});
