import { expect, test } from "@playwright/test";
import { control, eventually } from "@structure-ai/playwright/test";

test("a todo seeded through the control plane appears in the UI", async ({ page }) => {
  const title = `seeded-${crypto.randomUUID()}`;
  const { todoId } = await control.dispatch<{ todoId: string }>(
    "AddTodo",
    { title },
    { actor: "agent" },
  );
  expect(todoId).toMatch(/^todo-\d+$/);

  await page.goto("/");
  await eventually(async () => {
    await expect(page.getByTestId("todo-list")).toContainText(title);
  });
});

test("adding a todo through the UI converges into the projected list", async ({ page }) => {
  const title = `ui-${crypto.randomUUID()}`;
  await page.goto("/");
  await page.getByTestId("new-todo").fill(title);
  await page.getByTestId("add-todo").click();
  await eventually(async () => {
    await expect(page.getByTestId("todo-list")).toContainText(title);
  });
});

test("completing a seeded todo through the UI strikes it through", async ({ page }) => {
  const title = `done-${crypto.randomUUID()}`;
  const { todoId } = await control.dispatch<{ todoId: string }>("AddTodo", { title });
  await page.goto("/");
  await eventually(async () => {
    await expect(page.getByTestId(`title-${todoId}`)).toBeVisible();
  });
  await page.getByTestId(`complete-${todoId}`).click();
  await eventually(async () => {
    await expect(page.getByTestId(`title-${todoId}`)).toHaveCSS(
      "text-decoration-line",
      "line-through",
    );
  });
});

test("business failures surface by tag, not as transport errors", async () => {
  const attempt = control.dispatch("CompleteTodo", { todoId: "todo-does-not-exist" });
  await expect(attempt).rejects.toMatchObject({ tag: "TodoNotFound" });
});

test("the event store is readable from specs", async () => {
  const title = `event-${crypto.randomUUID()}`;
  await control.dispatch("AddTodo", { title });
  const events = await control.events();
  expect(events.some((event) => event.type === "TodoAdded")).toBe(true);
});

test("auth.register seeds a verified, signable-in user", async () => {
  const email = `agent-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { userId } = await control.auth.register({
    email,
    password: "correct horse battery staple",
  });
  expect(typeof userId).toBe("string");
  expect(userId.length).toBeGreaterThan(0);
});
