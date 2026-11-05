// Offline visual proposal. All names, records and version status are fixtures.
// No API calls, persistent storage, real configuration, or service operations.
const records = [
  [
    "10:42:18",
    "发送",
    "sent",
    "QQ · 群聊 A",
    "好的，整理后的清单已经发给你了。",
  ],
  [
    "10:42:15",
    "处理",
    "processing",
    "QQ · 群聊 A",
    "模型已接收本轮请求，正在等待回复。",
  ],
  [
    "10:42:14",
    "收到",
    "received",
    "QQ · 群聊 A",
    "@伙伴 帮我整理一下今天的待办。",
  ],
  ["10:39:52", "发送", "sent", "QQ · 私聊 A", "明白，我们接着刚才的话题聊。"],
  [
    "10:39:49",
    "处理",
    "processing",
    "QQ · 私聊 A",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:39:48", "收到", "received", "QQ · 私聊 A", "继续刚才那个想法吧。"],
  [
    "10:36:21",
    "发送",
    "sent",
    "QQ · 群聊 B",
    "图片里是窗边的一盆绿植。 [图片]",
  ],
  [
    "10:36:17",
    "处理",
    "processing",
    "QQ · 群聊 B",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:36:16", "收到", "received", "QQ · 群聊 B", "看看这张图。 [图片]"],
  ["10:32:08", "状态", "system", "QQ · 系统", "原生聊天已启动。"],
  ["10:32:07", "状态", "system", "QQ · 系统", "正在启动原生聊天。"],
  [
    "10:30:25",
    "模拟",
    "simulated",
    "模拟 · 本地",
    "[本地捕获] 回复已保存到本地模拟记录。",
  ],
  [
    "10:30:21",
    "模拟",
    "simulated",
    "模拟 · 本地",
    "[处理] 模型已接收本轮请求。",
  ],
  ["10:30:20", "模拟", "simulated", "模拟 · 本地", "[收到] 这是一条测试消息。"],
  ["10:26:13", "发送", "sent", "QQ · 私聊 B", "收到，下次我们再继续。"],
  [
    "10:26:11",
    "处理",
    "processing",
    "QQ · 私聊 B",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:26:10", "收到", "received", "QQ · 私聊 B", "今天先到这里吧。"],
  ["10:24:08", "发送", "sent", "QQ · 群聊 A", "可以，就按这个顺序来。"],
  [
    "10:24:05",
    "处理",
    "processing",
    "QQ · 群聊 A",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:24:04", "收到", "received", "QQ · 群聊 A", "先把这几件事情排一下顺序。"],
  ["10:21:36", "发送", "sent", "QQ · 私聊 A", "我记得，我们刚才聊到这里。"],
  [
    "10:21:33",
    "处理",
    "processing",
    "QQ · 私聊 A",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:21:32", "收到", "received", "QQ · 私聊 A", "我们之前说到哪里了？"],
  ["10:18:45", "发送", "sent", "QQ · 群聊 B", "看到了，照片里的光线很柔和。"],
  [
    "10:18:41",
    "处理",
    "processing",
    "QQ · 群聊 B",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:18:40", "收到", "received", "QQ · 群聊 B", "刚拍的照片。 [图片]"],
  ["10:15:02", "发送", "sent", "QQ · 私聊 B", "早上好，今天有什么安排？"],
  [
    "10:14:59",
    "处理",
    "processing",
    "QQ · 私聊 B",
    "模型已接收本轮请求，正在等待回复。",
  ],
  ["10:14:58", "收到", "received", "QQ · 私聊 B", "早上好。"],
];
const activity = document.querySelector("#activity-rows");
function renderRecords(source = "all") {
  activity.replaceChildren();
  for (const [time, label, kind, origin, content] of records) {
    if (
      (source === "qq" && kind === "simulated") ||
      (source === "simulation" && kind !== "simulated")
    )
      continue;
    const row = document.createElement("div");
    row.className = "activity-row";
    const cells = [
      ["time", "", time],
      ["span", kind, label],
      ["span", "source", origin],
      ["span", "content", content],
      ["button", "", "⋯"],
    ];
    for (const [tag, className, value] of cells) {
      const cell = document.createElement(tag);
      cell.className = className;
      cell.textContent = value;
      cell.title = value;
      if (tag === "button")
        cell.setAttribute("aria-label", `查看 ${time} 活动详情`);
      row.append(cell);
    }
    activity.append(row);
  }
}
renderRecords();
const notice = document.querySelector("#preview-notice");
let noticeTimer;
function showNotice(
  message = "这是静态设计预览，此操作不会修改配置或调用服务。",
) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = false;
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 3500);
}
const dialog = document.querySelector("#version-dialog");
document
  .querySelector("#version-trigger")
  .addEventListener("click", () => dialog.showModal());
document
  .querySelector("#close-dialog")
  .addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    dialog.close();
});
document.querySelector("#check-update").addEventListener("click", () => {
  document.querySelector("#check-status").textContent =
    "静态示例：当前已是最新正式版本";
});
document.querySelector("#theme").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = event.target.value;
});
document.querySelectorAll("[data-surface-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    document.documentElement.dataset.surface = button.dataset.surfaceChoice;
    document.querySelectorAll("[data-surface-choice]").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === button));
    });
  });
});
document.querySelectorAll("[data-source]").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-source]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
    renderRecords(button.dataset.source);
  });
});
const sidebarToggle = document.querySelector("#sidebar-toggle");
const scrim = document.querySelector(".sidebar-scrim");
const mobile = window.matchMedia("(max-width: 760px)");
function closeMobileSidebar() {
  document.body.classList.remove("mobile-open");
  scrim.hidden = true;
  if (mobile.matches) sidebarToggle.setAttribute("aria-expanded", "false");
}
function synchronizeSidebar() {
  closeMobileSidebar();
  if (mobile.matches) document.body.classList.remove("sidebar-collapsed");
  sidebarToggle.setAttribute(
    "aria-expanded",
    String(
      !mobile.matches && !document.body.classList.contains("sidebar-collapsed"),
    ),
  );
}
synchronizeSidebar();
mobile.addEventListener("change", synchronizeSidebar);
sidebarToggle.addEventListener("click", () => {
  if (mobile.matches) {
    const open = document.body.classList.toggle("mobile-open");
    scrim.hidden = !open;
    sidebarToggle.setAttribute("aria-expanded", String(open));
  } else {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  }
});
scrim.addEventListener("click", closeMobileSidebar);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileSidebar();
});
document.querySelectorAll(".settings-group").forEach((group) => {
  group.addEventListener("change", () => {
    group.querySelectorAll(".save").forEach((button) => {
      button.disabled = false;
    });
    showNotice("已修改预览值；仅用于查看编辑样式，不会保存到框架。");
  });
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (
    !button ||
    button.id ||
    button.hasAttribute("data-source") ||
    button.hasAttribute("data-surface-choice") ||
    button === scrim
  )
    return;
  if (button.closest("nav")) closeMobileSidebar();
  showNotice(button.dataset.preview);
});
