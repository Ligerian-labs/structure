// Vanilla frontend for the fixture: a projection-backed list that polls, so
// eventual consistency is visible to the user (and to specs) without reloads.
const list = document.querySelector('[data-testid="todo-list"]');
const form = document.querySelector('[data-testid="add-form"]');
const input = document.querySelector('[data-testid="new-todo"]');

const render = (todos) => {
  list.replaceChildren();
  for (const todo of todos) {
    const li = document.createElement("li");
    li.dataset.testid = "todo-item";
    li.dataset.todoId = todo.id;
    if (todo.done) li.classList.add("done");

    const title = document.createElement("span");
    title.className = "title";
    title.dataset.testid = `title-${todo.id}`;
    title.textContent = todo.title;
    li.append(title);

    if (!todo.done) {
      const complete = document.createElement("button");
      complete.dataset.testid = `complete-${todo.id}`;
      complete.type = "button";
      complete.textContent = "done";
      complete.addEventListener("click", async () => {
        await fetch("/api/todos/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ todoId: todo.id }),
        });
        refresh();
      });
      li.append(complete);
    }
    list.append(li);
  }
};

const refresh = async () => {
  const response = await fetch("/api/todos");
  if (!response.ok) return;
  const body = await response.json();
  render(body.todos);
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (title.length === 0) return;
  await fetch("/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  input.value = "";
  refresh();
});

refresh();
setInterval(refresh, 800);
