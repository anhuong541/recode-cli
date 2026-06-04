# SYSTEM CONTEXT: VIBE-RECOVERY — CLI TOOL KHÔI PHỤC CODE CHƯA COMMIT

## 1. MỤC TIÊU

Xây dựng CLI tool (Node.js/TypeScript) chạy ngầm, tự động snapshot code chưa commit của các project đang làm, để khi AI agent hoặc người dùng vô tình xóa/ghi đè code, có thể khôi phục **chính xác từng byte** chỉ bằng một câu lệnh — hoặc để AI agent tự làm thay người dùng.

Triết lý: **"Set & Forget"** — cài một lần, sau đó người dùng không cần nhớ gì.

Người dùng mục tiêu: "Vibe Coder" — người code chủ yếu bằng AI (Cursor, Claude Code, Windsurf), ít thao tác Git, thường để AI tự commit.

Nền tảng ưu tiên: **macOS/Linux** (bắt buộc chạy tốt), sau đó Windows 10/11.

---

## 2. PAIN POINT & ĐỊNH VỊ

Git chỉ bảo vệ code đã commit. Code đang sửa dở mất khi:

- AI agent ghi đè file, refactor quá tay, xóa nhầm file/hàm.
- AI hoặc người dùng chạy `git checkout -- .`, `git reset --hard`, `git clean -fdx`, `rm -rf`.
- AI bị ngắt giữa chừng (token limit) để lại file dở dang.

Công cụ hiện có không đủ:

- Cursor Local History / Checkpoint: gắn với IDE, chỉ theo dõi thay đổi của chính nó.
- Claude Code checkpoint: không bắt được lệnh bash hoặc thay đổi ngoài agent.
- `git stash`: phải nhớ chạy trước.
- Jujutsu: chỉ snapshot khi chạy lệnh jj; muốn liên tục phải cài Watchman; buộc đổi VCS.

Điểm khác biệt của Vibe-Recovery:

1. Độc lập IDE, không đổi VCS, chạy tốt trên macOS/Linux.
2. Snapshot liên tục theo file event.
3. Tự phát hiện và **pin** trạng thái ngay trước các đợt xóa lớn.
4. Giao diện máy đọc được (`--json`, MCP) để AI tự khôi phục an toàn.

---

## 3. NGUYÊN TẮC THIẾT KẾ BẤT BIẾN (KHÔNG ĐƯỢC VI PHẠM)

1. **Snapshot không bao giờ nằm trong working tree của project.** Mọi dữ liệu lưu ở `~/.vibe/`. Lý do: các sự cố cần khôi phục (`rm -rf`, `git clean -fdx`, AI dọn dẹp) xảy ra chính trong thư mục project.
2. **Không cơ chế tự động nào được làm mất điểm khôi phục duy nhất.** Commit hay clean chỉ đánh dấu snapshot, không xóa ngay. Xóa chỉ do GC sau thời gian ân hạn.
3. **Restore phải chính xác từng byte và do tool thực hiện.** AI không bao giờ tự viết lại code từ context/trí nhớ.
4. **Mọi restore đều đảo ngược được.** Trước khi restore luôn tự snapshot trạng thái hiện tại.
5. **Không sửa file được track của người dùng** (không tự động sửa `.gitignore`).
6. **Hỏng thì phải kêu.** Daemon chết hoặc project không được bảo vệ phải hiển thị rõ ràng (`vibe status`, cảnh báo), không được thất bại âm thầm.

---

## 4. KIẾN TRÚC KỸ THUẬT

### A. Lưu trữ: Shadow Git Repo

Mỗi project có một bare repo riêng ở ngoài project:

```text
~/.vibe/
├── config.json                 # Cấu hình global: danh sách project, retention, ngưỡng
├── daemon.lock / daemon.pid    # Đảm bảo chỉ 1 instance
├── daemon.log
└── repos/
    └── <repo-id>/              # repo-id = hash đường dẫn tuyệt đối đã chuẩn hóa
        ├── store.git/          # Bare repo chứa snapshot (git objects)
        ├── index               # Index tạm, không đụng index của người dùng
        └── meta.json           # Đường dẫn project, trạng thái, danh sách pin
```

Tạo snapshot bằng git plumbing (yêu cầu Git có sẵn trên máy):

```bash
GIT_DIR=~/.vibe/repos/<id>/store.git \
GIT_INDEX_FILE=~/.vibe/repos/<id>/index \
GIT_WORK_TREE=<project> \
  git add -A
tree=$(git write-tree)                  # cùng biến môi trường
# Nếu tree == tree của snapshot trước → bỏ qua (không có thay đổi)
commit=$(git commit-tree $tree -p <snapshot-trước> -m "<metadata JSON>")
git update-ref refs/vibe/<branch-hiện-tại> $commit
```

Lợi ích:

- Dedup tự nhiên, snapshot liên tục vẫn nhẹ.
- Tôn trọng `.gitignore` của project (đọc từ work tree).
- Xử lý đúng file mới, file bị xóa, rename, binary.
- Không làm bẩn `git log`, `git status`, `git stash` của người dùng.
- Sống sót cả khi thư mục `.git` hoặc toàn bộ project bị xóa.

Metadata mỗi snapshot (lưu trong commit message dạng JSON): `timestamp`, `branch`, `baseCommit` (HEAD của người dùng lúc đó), `trigger` (`watch` | `manual` | `pre-restore` | `agent-hook`), `stats` (file thêm/sửa/xóa, số dòng +/-), `pinned`, `pinReason`.

Giới hạn an toàn: bỏ qua file > 5MB (cấu hình được) và ghi cảnh báo.

### B. File Watcher

- Engine: `@parcel/watcher` (native, ổn định trên macOS/Linux). Fallback: `chokidar`.
- Ignore: tôn trọng `.gitignore` + danh sách mặc định (`node_modules`, `.git` trừ ngoại lệ bên dưới, `.next`, `dist`, `build`, `out`, `coverage`, `.turbo`, `.cache`, `target`, `*.log`).
- **Debounce 1.5–2s + maxWait 10s:** gom thay đổi liên tục thành 1 snapshot; nếu ghi liên tục không nghỉ thì cứ tối đa 10s vẫn snapshot một lần.
- **Ngoại lệ trong `.git`:** chỉ theo dõi `.git/HEAD` và `.git/logs/HEAD` để phát hiện commit/checkout/reset.
- **Fallback polling:** tự phát hiện đường dẫn mà file event không đáng tin (`\\wsl$\...`, ổ mạng, Docker volume) → chuyển sang polling 5s và ghi cảnh báo trong `vibe status`.
- Snapshot đầu tiên khi bắt đầu theo dõi một project (baseline).

### C. Phát hiện bất thường & Auto-Pin (tính năng quan trọng nhất)

Khi snapshot mới so với snapshot trước thỏa một trong các điều kiện sau → **pin snapshot trước đó**:

- Một file bị giảm > 50% số dòng (và file gốc > 20 dòng).
- Tổng số dòng bị xóa > 30% tổng số dòng đã thay đổi trong project, với tối thiểu 50 dòng.
- ≥ 3 file bị xóa trong một snapshot.
- HEAD thay đổi theo kiểu `reset` / `checkout` trong khi working tree đang có thay đổi chưa commit.

Ngưỡng đều cấu hình được. Pin kèm `pinReason` dễ đọc, ví dụ: `"src/App.tsx giảm từ 340 → 12 dòng"`.

### D. Retention & GC (theo thời gian, KHÔNG theo số lượng)

| Tuổi snapshot | Giữ lại           |
| ------------- | ----------------- |
| < 2 giờ       | Tất cả            |
| 2 – 24 giờ    | 1 bản mỗi 15 phút |
| 1 – 7 ngày    | 1 bản mỗi giờ     |
| > 7 ngày      | Xóa               |

Quy tắc bổ sung:

- **Snapshot đã pin:** không bao giờ bị GC tự động trong 14 ngày.
- **Commit-aware:** khi phát hiện commit, snapshot nào có nội dung trùng khớp hoàn toàn với tree của một commit trong lịch sử được đánh dấu `covered`. Snapshot `covered` bị xóa sau **24 giờ ân hạn** (không xóa ngay).
- Snapshot chứa nội dung _không có trong bất kỳ commit nào_ thì tuân theo bảng retention bình thường, **không bị xóa sớm vì commit**.
- GC chạy mỗi giờ, rồi `git gc --prune` trên store.
- Giới hạn dung lượng mỗi project (mặc định 500MB): vượt thì cảnh báo, không tự xóa bản pin.

### E. Phát hiện Workspace & Vòng đời Daemon

Đăng ký project (không cần người dùng làm gì thêm sau lần cài đặt):

1. `vibe add [path]` — thủ công, một lần.
2. Tự đăng ký khi agent hook (Claude Code / Cursor) gọi lần đầu từ một repo.
3. Tùy chọn: khai báo thư mục gốc (ví dụ `D:\code`) → daemon quét tìm Git repo có hoạt động trong 7 ngày gần nhất và đăng ký tự động.

Project không có hoạt động trong 3 ngày → ngừng watch (giữ dữ liệu), watch lại khi có hook hoặc lệnh `vibe`.

Daemon:

- Single instance qua lock file. Mọi lệnh CLI giao tiếp với daemon qua named pipe (Windows) / Unix socket.
- `vibe service install`: Windows dùng Task Scheduler (chạy khi đăng nhập); macOS launchd; Linux systemd user service.
- Tự khởi động lại khi crash (tối đa 5 lần/giờ, sau đó dừng và ghi log).
- Heartbeat mỗi 30s vào `daemon.pid`; CLI kiểm tra heartbeat để biết daemon còn sống.
- Tài nguyên: đo thực tế; mục tiêu idle < 1% CPU, < 100MB RAM khi theo dõi 5 project cỡ trung.

### F. Restore

- `vibe restore <id>`: khôi phục toàn bộ project về snapshot. **Bắt buộc có xác nhận** (trừ khi `--yes`).
- `vibe restore <id> -- <path...>`: khôi phục từng file/thư mục (khuyến khích).
- Luôn tạo snapshot `pre-restore` trước khi ghi, in ra id để có thể `vibe restore <pre-restore-id>`.
- File bị xóa trong snapshot đích nhưng đang tồn tại hiện tại: khi restore toàn bộ thì hỏi trước khi xóa; khi restore từng file thì không đụng tới.
- Không bao giờ đụng vào `.git` hay index của người dùng.

---

## 5. CLI COMMANDS

| Lệnh                                                       | Chức năng                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `vibe setup`                                               | Cài đặt một lần: tạo `~/.vibe`, cài service, tùy chọn cài agent hooks |
| `vibe add [path]` / `vibe remove [path]`                   | Đăng ký / hủy theo dõi project                                        |
| `vibe status [--json]`                                     | Daemon còn sống không, project nào đang được bảo vệ, cảnh báo         |
| `vibe save [-m msg]`                                       | Snapshot thủ công                                                     |
| `vibe list [--json] [--pinned] [--since 2h]`               | Liệt kê snapshot của project hiện tại                                 |
| `vibe diff <id> [--against current\|HEAD\|<id>] [-- path]` | Xem khác biệt                                                         |
| `vibe show <id> [-- path]`                                 | In nội dung file tại snapshot                                         |
| `vibe restore <id> [-- path...] [--yes]`                   | Khôi phục                                                             |
| `vibe pin <id>` / `vibe unpin <id>`                        | Pin / bỏ pin thủ công                                                 |
| `vibe context [--json\|--md]`                              | Tóm tắt chuẩn hóa cho AI (xem mục 6)                                  |
| `vibe gc [--dry-run]`                                      | Chạy dọn dẹp thủ công                                                 |
| `vibe service install\|uninstall\|start\|stop`             | Quản lý daemon                                                        |

Mọi lệnh đọc đều hỗ trợ `--json` với schema ổn định, có trường `schemaVersion`.

---

## 6. GIAO TIẾP VỚI AI AGENT

### Context sinh theo yêu cầu (không ghi file realtime vào project)

`vibe context --md` in ra:

```markdown
# VIBE-RECOVERY CONTEXT — my-project (branch: feature/login)

HEAD: a1b2c3d "add login form" (2 giờ trước)
Trạng thái bảo vệ: OK (daemon đang chạy)

## Snapshot đã pin (ứng viên khôi phục hàng đầu)

- vb_0927_1458 — PINNED: "src/App.tsx giảm từ 340 → 12 dòng" — 3 files, +45/-8

## Snapshot gần đây (mới nhất trước)

- vb_0927_1502 — 2 files, +3/-328 — src/App.tsx, src/utils.ts
- vb_0927_1500 — 1 file, +12/-2 — src/App.tsx
- vb_0927_1458 — 3 files, +45/-8 — (PINNED)

## Lệnh

- Xem khác biệt: vibe diff <id> --against current -- <path>
- Khôi phục từng file: vibe restore <id> -- <path>
```

### MCP server (Phase 3)

Tools: `list_snapshots`, `get_context`, `diff_snapshot`, `restore_files` (bắt buộc truyền danh sách file, trả về id `pre-restore`).

### Quy tắc mẫu cho AI (nhúng vào `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/`)

```markdown
## Khôi phục code (Vibe-Recovery)

Khi người dùng báo mất code, xóa nhầm, muốn "quay lại", "rollback", "code cũ đâu rồi":

1. Chạy `vibe context --md` để xem các snapshot.
2. Ưu tiên snapshot PINNED gần nhất trước thời điểm sự cố.
3. Chạy `vibe diff <id> --against current -- <file>` để xác nhận đúng nội dung cần lấy lại.
4. Trình bày cho người dùng: snapshot nào, file nào, sẽ thay đổi gì. CHỜ người dùng xác nhận.
5. Khôi phục bằng `vibe restore <id> -- <file...>`, ưu tiên từng file thay vì toàn bộ project.
6. Báo lại id `pre-restore` để người dùng có thể hoàn tác.

KHÔNG BAO GIỜ tự viết lại code đã mất từ trí nhớ hay từ context — luôn dùng `vibe restore`.
Nếu người dùng chỉ báo "code bị lỗi" (bug), đừng rollback — hỏi xem họ muốn sửa lỗi hay khôi phục bản cũ.
```

### Agent hook (Phase 2)

Cài qua `vibe setup`: hook `PreToolUse` của Claude Code (cho các tool ghi file và Bash) gọi `vibe save --trigger agent-hook --quiet` để đảm bảo có snapshot ngay trước khi agent hành động. Hook phải hoàn thành < 300ms và không bao giờ chặn agent nếu lỗi.

---

## 7. KỊCH BẢN NGHIỆM THU (TEST BẮT BUỘC)

Mỗi kịch bản phải có test tự động (integration test trên repo tạm):

1. Sửa file → AI ghi đè còn 5 dòng → `vibe restore` từ bản pin → nội dung khớp byte với bản gốc.
2. Tạo file mới chưa track → `git clean -fd` → khôi phục được file.
3. Có thay đổi chưa commit → `git reset --hard` → khôi phục được; snapshot trước đó được auto-pin.
4. Xóa hàm → `git add -A && git commit` → hàm vẫn khôi phục được từ snapshot (không bị GC xóa vì commit).
5. Sau khi xóa code, thực hiện thêm 50 thay đổi → bản tốt vẫn còn (nhờ pin).
6. `rm -rf` toàn bộ thư mục project (kể cả `.git`) → khôi phục được vào thư mục mới.
7. Ghi file liên tục 30s không nghỉ → có snapshot nhờ maxWait.
8. Restore → hối hận → restore bản `pre-restore` → trở lại đúng trạng thái trước restore.
9. Kill daemon → `vibe status` báo rõ project KHÔNG được bảo vệ.
10. Trên macOS/Linux: đường dẫn có dấu tiếng Việt/khoảng trắng, file CRLF, file đang bị lock bởi IDE.

---

## 8. NGOÀI PHẠM VI (NON-GOALS)

- Không thay thế Git, không sync cloud, không chia sẻ snapshot giữa các máy.
- Không hỗ trợ thư mục không phải Git repo (giai đoạn đầu).
- Không lưu file lớn/binary vượt ngưỡng.
- Không dùng LLM để tự tóm tắt thay đổi (có thể cân nhắc sau).
- Không có GUI (ngoài tray icon ở Phase 3, nếu cần).

---

## 9. LỘ TRÌNH

- **Phase 1 — Lõi per-project (không daemon):** shadow repo, `vibe watch` chạy foreground trong một project, `save/list/diff/show/restore/pin/gc/context`, auto-pin, retention. Pass kịch bản 1–8, 10.
- **Phase 2 — Daemon & tự động hóa:** daemon global, IPC, `service install` (ưu tiên macOS/Linux), đăng ký project tự động, agent hook Claude Code, `vibe status`. Pass kịch bản 9.
- **Phase 3 — Tích hợp AI sâu:** MCP server, rules mẫu cho Cursor/Claude Code, tray icon.

---

## 10. NHIỆM VỤ CHO AGENT

Đóng vai Senior System Architect & CLI Developer (Node.js/TypeScript).

- **Chỉ triển khai Phase 1** cho đến khi tôi xác nhận chuyển phase.
- Bắt đầu bằng: cấu trúc thư mục dự án, lựa chọn thư viện (CLI parser, watcher, test runner) kèm lý do, và kế hoạch test cho các kịch bản ở mục 7.
- Tuân thủ tuyệt đối các nguyên tắc ở mục 3. Nếu một yêu cầu của tôi mâu thuẫn với chúng, hãy chỉ ra thay vì làm theo.
- Khi có điểm chưa rõ trong spec, hỏi trước khi giả định.
- Viết code chạy được trên macOS/Linux trước tiên (chú ý đường dẫn, spawn `git`, CRLF).
