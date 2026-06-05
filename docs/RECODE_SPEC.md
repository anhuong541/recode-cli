# SYSTEM CONTEXT: RECODE — CLI TOOL KHÔI PHỤC CODE CHƯA COMMIT

## 1. MỤC TIÊU

Xây dựng CLI tool (Node.js/TypeScript) chạy ngầm, tự động snapshot code chưa commit của các project đang làm, để khi AI agent hoặc người dùng vô tình xóa/ghi đè code, có thể khôi phục **chính xác từng byte** chỉ bằng một câu lệnh — hoặc để AI agent tự làm thay người dùng.

Triết lý: **"Set & Forget"** — cài một lần, sau đó người dùng không cần nhớ gì.

Người dùng mục tiêu: "Vibe Coder" — người code chủ yếu bằng AI (Cursor, Claude Code, Windsurf), ít thao tác Git, thường để AI tự commit.

Nền tảng ưu tiên: **Windows 10/11** (bắt buộc chạy tốt), sau đó macOS/Linux.

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

Điểm khác biệt của Recode:
1. Độc lập IDE, không đổi VCS, chạy tốt trên Windows.
2. Snapshot liên tục theo file event.
3. Tự phát hiện và **pin** trạng thái ngay trước các đợt xóa lớn.
4. AI **tự nhận biết** khi nào cần khôi phục và tự dùng Recode — người dùng không cần biết hay nhắc tên công cụ.

---

## 3. NGUYÊN TẮC THIẾT KẾ BẤT BIẾN (KHÔNG ĐƯỢC VI PHẠM)

1. **Snapshot không bao giờ nằm trong working tree của project.** Mọi dữ liệu lưu ở `~/.recode/`. Lý do: các sự cố cần khôi phục (`rm -rf`, `git clean -fdx`, AI dọn dẹp) xảy ra chính trong thư mục project.
2. **Không cơ chế tự động nào được làm mất điểm khôi phục duy nhất.** Commit hay clean chỉ đánh dấu snapshot, không xóa ngay. Xóa chỉ do GC sau thời gian ân hạn.
3. **Restore phải chính xác từng byte và do tool thực hiện.** AI không bao giờ tự viết lại code từ context/trí nhớ.
4. **Mọi restore đều đảo ngược được.** Trước khi restore luôn tự snapshot trạng thái hiện tại.
5. **Không sửa file được track của người dùng** (không tự động sửa `.gitignore`).
6. **Recode chủ động báo cho AI**, không trông chờ AI tự nhớ (xem mục 6).
7. **Hỏng thì phải kêu.** Daemon chết hoặc project không được bảo vệ phải hiển thị rõ ràng (`recode status`, cảnh báo), không được thất bại âm thầm.

---

## 4. KIẾN TRÚC KỸ THUẬT

### A. Lưu trữ: Shadow Git Repo

Mỗi project có một bare repo riêng ở ngoài project:

```text
~/.recode/
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
GIT_DIR=~/.recode/repos/<id>/store.git \
GIT_INDEX_FILE=~/.recode/repos/<id>/index \
GIT_WORK_TREE=<project> \
  git add -A
tree=$(git write-tree)                  # cùng biến môi trường
# Nếu tree == tree của snapshot trước → bỏ qua (không có thay đổi)
commit=$(git commit-tree $tree -p <snapshot-trước> -m "<metadata JSON>")
git update-ref refs/recode/<branch-hiện-tại> $commit
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

- Engine: `@parcel/watcher` (native, ổn định trên Windows). Fallback: `chokidar`.
- Ignore: tôn trọng `.gitignore` + danh sách mặc định (`node_modules`, `.git` trừ ngoại lệ bên dưới, `.next`, `dist`, `build`, `out`, `coverage`, `.turbo`, `.cache`, `target`, `*.log`).
- **Debounce 1.5–2s + maxWait 10s:** gom thay đổi liên tục thành 1 snapshot; nếu ghi liên tục không nghỉ thì cứ tối đa 10s vẫn snapshot một lần.
- **Ngoại lệ trong `.git`:** chỉ theo dõi `.git/HEAD` và `.git/logs/HEAD` để phát hiện commit/checkout/reset.
- **Fallback polling:** tự phát hiện đường dẫn mà file event không đáng tin (`\\wsl$\...`, ổ mạng, Docker volume) → chuyển sang polling 5s và ghi cảnh báo trong `recode status`.
- Snapshot đầu tiên khi bắt đầu theo dõi một project (baseline).

### C. Phát hiện bất thường & Auto-Pin (tính năng quan trọng nhất)

Khi snapshot mới so với snapshot trước thỏa một trong các điều kiện sau → **pin snapshot trước đó**:
- Một file bị giảm > 50% số dòng (và file gốc > 20 dòng).
- Tổng số dòng bị xóa > 30% tổng số dòng đã thay đổi trong project, với tối thiểu 50 dòng.
- ≥ 3 file bị xóa trong một snapshot.
- HEAD thay đổi theo kiểu `reset` / `checkout` trong khi working tree đang có thay đổi chưa commit.

Ngưỡng đều cấu hình được. Pin kèm `pinReason` dễ đọc, ví dụ: `"src/App.tsx giảm từ 340 → 12 dòng"`.

### D. Retention & GC (theo thời gian, KHÔNG theo số lượng)

| Tuổi snapshot | Giữ lại |
|---|---|
| < 2 giờ | Tất cả |
| 2 – 24 giờ | 1 bản mỗi 15 phút |
| 1 – 7 ngày | 1 bản mỗi giờ |
| > 7 ngày | Xóa |

Quy tắc bổ sung:
- **Snapshot đã pin:** không bao giờ bị GC tự động trong 14 ngày.
- **Commit-aware:** khi phát hiện commit, snapshot nào có nội dung trùng khớp hoàn toàn với tree của một commit trong lịch sử được đánh dấu `covered`. Snapshot `covered` bị xóa sau **24 giờ ân hạn** (không xóa ngay).
- Snapshot chứa nội dung *không có trong bất kỳ commit nào* thì tuân theo bảng retention bình thường, **không bị xóa sớm vì commit**.
- GC chạy mỗi giờ, rồi `git gc --prune` trên store.
- Giới hạn dung lượng mỗi project (mặc định 500MB): vượt thì cảnh báo, không tự xóa bản pin.

### E. Phát hiện Workspace & Vòng đời Daemon

Đăng ký project (không cần người dùng làm gì thêm sau lần cài đặt):
1. `recode add [path]` — thủ công, một lần.
2. Tự đăng ký khi agent hook (Claude Code / Cursor) gọi lần đầu từ một repo.
3. Tùy chọn: khai báo thư mục gốc (ví dụ `D:\code`) → daemon quét tìm Git repo có hoạt động trong 7 ngày gần nhất và đăng ký tự động.

Project không có hoạt động trong 3 ngày → ngừng watch (giữ dữ liệu), watch lại khi có hook hoặc lệnh `recode`.

Daemon:
- Single instance qua lock file. Mọi lệnh CLI giao tiếp với daemon qua named pipe (Windows) / Unix socket.
- `recode service install`: Windows dùng Task Scheduler (chạy khi đăng nhập); macOS launchd; Linux systemd user service.
- Tự khởi động lại khi crash (tối đa 5 lần/giờ, sau đó dừng và ghi log).
- Heartbeat mỗi 30s vào `daemon.pid`; CLI kiểm tra heartbeat để biết daemon còn sống.
- Tài nguyên: đo thực tế; mục tiêu idle < 1% CPU, < 100MB RAM khi theo dõi 5 project cỡ trung.

### F. Restore

- `recode restore <id>`: khôi phục toàn bộ project về snapshot. **Bắt buộc có xác nhận** (trừ khi `--yes`).
- `recode restore <id> -- <path...>`: khôi phục từng file/thư mục (khuyến khích).
- Luôn tạo snapshot `pre-restore` trước khi ghi, in ra id để có thể `recode restore <pre-restore-id>`.
- File bị xóa trong snapshot đích nhưng đang tồn tại hiện tại: khi restore toàn bộ thì hỏi trước khi xóa; khi restore từng file thì không đụng tới.
- Không bao giờ đụng vào `.git` hay index của người dùng.

---

## 5. CLI COMMANDS

| Lệnh | Chức năng |
|---|---|
| `recode setup` | Cài đặt một lần: tạo `~/.recode`, cài service, đăng ký MCP, cài hooks và rules toàn cục cho các agent phát hiện được |
| `recode add [path]` / `recode remove [path]` | Đăng ký / hủy theo dõi project |
| `recode status [--json]` | Daemon còn sống không, project nào đang được bảo vệ, cảnh báo |
| `recode save [-m msg]` | Snapshot thủ công |
| `recode list [--json] [--pinned] [--since 2h]` | Liệt kê snapshot của project hiện tại |
| `recode diff <id> [--against current\|HEAD\|<id>] [-- path]` | Xem khác biệt |
| `recode show <id> [-- path]` | In nội dung file tại snapshot |
| `recode restore <id> [-- path...] [--yes]` | Khôi phục |
| `recode pin <id>` / `recode unpin <id>` | Pin / bỏ pin thủ công |
| `recode context [--json\|--md]` | Tóm tắt chuẩn hóa cho AI (xem mục 6) |
| `recode gc [--dry-run]` | Chạy dọn dẹp thủ công |
| `recode service install\|uninstall\|start\|stop` | Quản lý daemon |
| `recode mcp` | Chạy MCP server (stdio) — được agent gọi, người dùng không chạy tay |
| `recode hook <event>` | Entry point cho hooks của agent (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse) |
| `recode uninstall` | Gỡ sạch service, MCP, hooks, block rules đã cài |

Mọi lệnh đọc đều hỗ trợ `--json` với schema ổn định, có trường `schemaVersion`.

---

## 6. GIAO TIẾP VỚI AI AGENT & CƠ CHẾ TỰ NHẬN BIẾT

### Mục tiêu

Người dùng **không cần biết hay nhắc tên Recode**. AI phải tự biết ba điều:
1. Recode đang tồn tại và bảo vệ repo này.
2. Khi nào cần dùng: khi người dùng mô tả triệu chứng mất code, kể cả không dùng từ khóa kỹ thuật ("sao trang login trống trơn", "cái hàm hồi nãy đâu rồi").
3. Sự cố vừa xảy ra, kể cả khi **chính AI gây ra** mà người dùng chưa phát hiện.

### Nguyên tắc: Recode chủ động báo cho AI, không trông chờ AI tự nhớ

Rules trong file hướng dẫn có thể bị loãng trong context dài hoặc bị bỏ qua. Tín hiệu do tool đẩy vào đúng thời điểm thì không. Vì vậy thiết kế theo **3 lớp**, lớp sau là dự phòng cho lớp trước.

Lưu ý thực tế: hành vi LLM mang tính xác suất, không cơ chế nào đảm bảo 100%. Mục tiêu là tối đa hóa tỉ lệ và **đo được** tỉ lệ đó bằng eval (mục 7B).

### Lớp 1 — MCP server: luôn hiện diện trong danh sách tool của AI

Tool description luôn nằm trong context của agent ở mọi lượt, nên AI biết khả năng này mà không cần rules.

- `recode setup` đăng ký MCP server tên `recode` ở **mức user/global**, không phải per-project:
  - Claude Code: `claude mcp add --scope user recode -- recode mcp`
  - Cursor: thêm vào `~/.cursor/mcp.json`
- Transport: stdio (`recode mcp`), giao tiếp với daemon qua IPC.
- Tools:

| Tool | Chức năng |
|---|---|
| `recode_get_context` | Trạng thái bảo vệ, alert chưa xử lý, snapshot pin & gần đây |
| `recode_list_snapshots` | Lọc theo thời gian, file, pinned |
| `recode_diff` | Diff snapshot với hiện tại / HEAD / snapshot khác, theo file |
| `recode_show_file` | Nội dung file tại một snapshot |
| `recode_restore_files` | Khôi phục danh sách file cụ thể, trả về id `pre-restore` |

- **Tool description viết theo triệu chứng, không theo tên sản phẩm.** Mẫu cho `recode_get_context`:

```text
Local safety net that continuously snapshots UNCOMMITTED code in this repository.
Call this FIRST whenever: code, functions, files or UI appear missing, deleted,
emptied, overwritten or reverted; the user asks where earlier code went or wants
a previous/earlier version ("mất", "biến mất", "đâu rồi", "xóa nhầm", "hồi nãy",
"bản cũ", "quay lại", "lost", "gone", "undo", "revert"); or after you notice your
own edit removed more than intended. Also call it BEFORE trying to rewrite lost
code from memory — the exact original bytes are usually recoverable here.
Read-only; never modifies files.
```

### Lớp 2 — Hooks đẩy tín hiệu chủ động (lớp quan trọng nhất)

Daemon ghi **alert** mỗi khi auto-pin (mục 4C) vào `~/.recode/repos/<id>/alerts.json`. Alert có trạng thái `open` → `acknowledged` (AI đã xem) → `resolved` (đã restore hoặc người dùng bỏ qua), và tự hết hạn sau 24 giờ.

Claude Code (`recode setup` cài vào `~/.claude/settings.json`, mức user):

| Hook | Hành vi |
|---|---|
| `SessionStart` | Inject 1 dòng: "Recode đang bảo vệ repo này (N snapshot, M pinned). Dùng MCP `recode` khi code có dấu hiệu bị mất." Nếu có alert `open` → inject chi tiết alert. |
| `UserPromptSubmit` | Chỉ inject khi (a) có alert `open` trong 60 phút gần nhất, hoặc (b) prompt khớp từ khóa triệu chứng. Nội dung ≤ 5 dòng. Không khớp gì → không inject (tránh tốn token). |
| `PostToolUse` (Write, Edit, MultiEdit, Bash) | Ngay sau khi agent sửa file, nếu phát hiện co rút bất thường **trong chính lượt đó** → phản hồi cho agent: "Thay đổi vừa rồi làm `src/App.tsx` giảm 340 → 12 dòng. Bản trước đã được pin `rc_0927_1458`. Nếu không cố ý, hãy báo người dùng và đề xuất khôi phục." |
| `PreToolUse` (Write, Edit, MultiEdit, Bash) | `recode save --trigger agent-hook --quiet` để có snapshot ngay trước khi agent hành động. |

`PostToolUse` giúp AI **tự phát hiện lỗi của chính mình** trước khi người dùng nhận ra. Đây là kịch bản phổ biến nhất.

Cursor: dùng hệ thống hooks của Cursor (sau khi sửa file, trước khi gửi prompt…) trong phạm vi Cursor hỗ trợ. Khả năng inject context có thể hạn chế hơn Claude Code, nên với Cursor thì Lớp 1 và Lớp 3 là chính. **Cần kiểm tra tài liệu hooks của phiên bản Cursor hiện hành trước khi triển khai.**

Yêu cầu chung cho mọi hook:
- Hoàn thành < 300ms; lỗi thì **fail-open** (không bao giờ chặn agent).
- Output ngắn; không có gì để nói thì không output.
- Không bao giờ tự restore từ hook.

Từ khóa triệu chứng mặc định (cấu hình được, so khớp không dấu và có dấu): `mất`, `biến mất`, `đâu rồi`, `không thấy`, `bị xóa`, `xóa nhầm`, `trống trơn`, `hồi nãy`, `lúc nãy`, `bản cũ`, `quay lại`, `hoàn tác`, `khôi phục`, `lost`, `deleted`, `disappeared`, `gone`, `missing`, `undo`, `revert`, `rollback`, `restore`, `previous version`.

### Lớp 3 — Rules toàn cục (dự phòng cho agent không có hook/MCP)

- Claude Code: ghi vào `~/.claude/CLAUDE.md` (mức user) trong block có marker `<!-- recode:start --> … <!-- recode:end -->`, để `recode setup` cập nhật và `recode uninstall` gỡ sạch.
- Cursor: User Rules nằm trong Settings, không ghi được bằng file → `recode setup` in đoạn rules ra và hướng dẫn dán **một lần**. Tùy chọn per-project: tạo `.cursor/rules/recode.mdc` (`alwaysApply: true`) và thêm vào `.git/info/exclude` để không sửa file được track (nguyên tắc 5).
- Agent khác: in hướng dẫn thêm vào `AGENTS.md` nếu người dùng muốn.

Nội dung rules:

```markdown
## An toàn code (Recode)
Máy này có Recode — công cụ tự động snapshot code CHƯA commit (MCP server `recode`, CLI `recode`).
Người dùng có thể không biết tên công cụ này. Hãy tự dùng nó, không chờ được nhắc.

Dùng Recode khi:
- Người dùng mô tả code/file/hàm/giao diện bị mất, trống, biến mất, bị ghi đè, "hồi nãy còn", muốn bản trước.
- Bạn nhận được cảnh báo từ Recode (hook, alert).
- Bạn nhận ra chính mình vừa xóa hoặc ghi đè nhiều hơn dự định.
- Bạn định viết lại code đã mất từ trí nhớ → dừng lại, kiểm tra Recode trước.

Quy trình:
1. Gọi `recode_get_context` (hoặc `recode context --md`).
2. Ưu tiên snapshot PINNED gần nhất trước thời điểm sự cố.
3. Xem diff theo file để xác nhận đúng nội dung.
4. Trình bày ngắn gọn: snapshot nào, file nào, sẽ thay đổi gì → chờ người dùng đồng ý (trừ khi cấu hình cho phép tự restore).
5. Khôi phục từng file bằng `recode_restore_files`, báo lại id `pre-restore` để hoàn tác.

KHÔNG tự viết lại code đã mất từ trí nhớ khi Recode có thể khôi phục chính xác.
Nếu người dùng chỉ báo lỗi logic (bug) mà không có dấu hiệu mất code → sửa lỗi bình thường, không rollback.
```

### Mức độ tự động khi restore

Cấu hình `restore.mode` trong `~/.recode/config.json`:
- `ask` (mặc định): AI **chủ động phát hiện và đề xuất**, cho xem diff, người dùng chỉ cần trả lời "ok". Người dùng không cần nhớ tên hay gõ lệnh gì.
- `self-inflicted-auto`: AI được tự restore **từng file**, không cần hỏi, chỉ khi thỏa **cả ba** điều kiện: (1) `PostToolUse` xác nhận chính agent vừa gây ra thay đổi bất thường trong cùng lượt, (2) người dùng chưa sửa file đó sau thời điểm đó, (3) agent báo lại ngay sau khi làm kèm id `pre-restore`.
- Không có chế độ nào cho phép tự restore **toàn bộ project** mà không hỏi.

### Context sinh theo yêu cầu

`recode context --md` (và `recode_get_context`) trả về:

```markdown
# RECODE CONTEXT — my-project (branch: feature/login)
HEAD: a1b2c3d "add login form" (2 giờ trước)
Trạng thái bảo vệ: OK (daemon đang chạy)

## Alert chưa xử lý
- 15:02 — src/App.tsx giảm 340 → 12 dòng (do agent-hook). Bản tốt: rc_0927_1458 (PINNED)

## Snapshot đã pin
- rc_0927_1458 — PINNED — 3 files, +45/-8

## Snapshot gần đây (mới nhất trước)
- rc_0927_1502 — 2 files, +3/-328 — src/App.tsx, src/utils.ts
- rc_0927_1500 — 1 file, +12/-2 — src/App.tsx
- rc_0927_1458 — 3 files, +45/-8 — (PINNED)

## Lệnh
- Xem khác biệt: recode diff <id> --against current -- <path>
- Khôi phục từng file: recode restore <id> -- <path>
```

---

## 7. KỊCH BẢN NGHIỆM THU

### 7A. Test chức năng (bắt buộc)

Mỗi kịch bản phải có test tự động (integration test trên repo tạm):

1. Sửa file → AI ghi đè còn 5 dòng → `recode restore` từ bản pin → nội dung khớp byte với bản gốc.
2. Tạo file mới chưa track → `git clean -fd` → khôi phục được file.
3. Có thay đổi chưa commit → `git reset --hard` → khôi phục được; snapshot trước đó được auto-pin.
4. Xóa hàm → `git add -A && git commit` → hàm vẫn khôi phục được từ snapshot (không bị GC xóa vì commit).
5. Sau khi xóa code, thực hiện thêm 50 thay đổi → bản tốt vẫn còn (nhờ pin).
6. `rm -rf` toàn bộ thư mục project (kể cả `.git`) → khôi phục được vào thư mục mới.
7. Ghi file liên tục 30s không nghỉ → có snapshot nhờ maxWait.
8. Restore → hối hận → restore bản `pre-restore` → trở lại đúng trạng thái trước restore.
9. Kill daemon → `recode status` báo rõ project KHÔNG được bảo vệ.
10. Trên Windows: đường dẫn có dấu tiếng Việt/khoảng trắng, file CRLF, file đang bị lock bởi IDE.

### 7B. Eval nhận biết của AI (chạy với Claude Code thật, lặp mỗi kịch bản ≥ 10 lần)

Chuẩn bị: repo mẫu, Recode đã `setup`, **prompt không bao giờ chứa từ "recode"**.

| # | Tình huống | Kỳ vọng | Ngưỡng đạt |
|---|---|---|---|
| E1 | Xóa tay nửa file, prompt: "sao trang login trống trơn vậy?" | AI gọi `recode_get_context` trước khi sửa code | ≥ 90% |
| E2 | Prompt yêu cầu refactor; agent vô tình xóa một hàm | AI tự báo và đề xuất khôi phục nhờ `PostToolUse`, trước khi người dùng hỏi | ≥ 80% |
| E3 | `git reset --hard` từ terminal, prompt: "code hồi nãy đâu rồi" | AI tìm đúng snapshot pinned | ≥ 90% |
| E4 | Prompt: "cái hàm validate lúc nãy mình viết, viết lại giúp" | AI khôi phục từ snapshot thay vì viết lại từ trí nhớ | ≥ 80% |
| E5 | Prompt báo bug logic thông thường, không mất code | AI **không** đề xuất rollback | ≥ 95% |
| E6 | Session dài (> 100 lượt), sau đó xảy ra mất code | Tỉ lệ như E1 (kiểm tra độ bền khi context dài) | ≥ 85% |

Ghi lại tỉ lệ theo từng phiên bản rules/tool description để so sánh khi chỉnh sửa.

---

## 8. NGOÀI PHẠM VI (NON-GOALS)

- Không thay thế Git, không sync cloud, không chia sẻ snapshot giữa các máy.
- Không hỗ trợ thư mục không phải Git repo (giai đoạn đầu).
- Không lưu file lớn/binary vượt ngưỡng.
- Không dùng LLM để tự tóm tắt thay đổi (có thể cân nhắc sau).
- Không có GUI (ngoài tray icon ở Phase 3, nếu cần).

---

## 9. LỘ TRÌNH

- **Phase 1 — Lõi per-project (không daemon):** shadow repo, `recode watch` chạy foreground trong một project, `save/list/diff/show/restore/pin/gc/context`, auto-pin, alerts, retention. Pass kịch bản 7A: 1–8, 10.
- **Phase 2 — Daemon & AI tự nhận biết:** daemon global, IPC, `service install` (ưu tiên Windows Task Scheduler), đăng ký project tự động, `recode status`, **MCP server, hooks Claude Code (Lớp 2), rules toàn cục (Lớp 3)**. Pass kịch bản 7A: 9 và eval 7B.
- **Phase 3 — Mở rộng:** hooks Cursor và agent khác, chế độ `self-inflicted-auto`, tray icon.

---

## 10. NHIỆM VỤ CHO AGENT

Đóng vai Senior System Architect & CLI Developer (Node.js/TypeScript).

- **Chỉ triển khai Phase 1** cho đến khi tôi xác nhận chuyển phase.
- Bắt đầu bằng: cấu trúc thư mục dự án, lựa chọn thư viện (CLI parser, watcher, test runner) kèm lý do, và kế hoạch test cho các kịch bản ở mục 7.
- Tuân thủ tuyệt đối các nguyên tắc ở mục 3. Nếu một yêu cầu của tôi mâu thuẫn với chúng, hãy chỉ ra thay vì làm theo.
- Khi có điểm chưa rõ trong spec, hỏi trước khi giả định.
- Viết code chạy được trên Windows trước tiên (chú ý đường dẫn, spawn `git`, CRLF).
