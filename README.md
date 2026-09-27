# recode

Snapshot liên tục code **chưa commit** ra ngoài project (`~/.recode/`), khôi phục chính xác từng byte bằng một lệnh.
Spec đầy đủ: [docs/RECODE_SPEC.md](docs/RECODE_SPEC.md).

Trạng thái: **Phase 1 — lõi per-project, chưa có daemon.** Chưa có `setup`, `status`, `service`, MCP, hooks (Phase 2).

## Yêu cầu

- Node.js >= 22.12
- Git >= 2.31 có trong `PATH`

## Cài đặt khi phát triển

```bash
bun install
bun run build
npm link   # để có lệnh `recode`
```

## Lệnh (Phase 1)

| Lệnh | Chức năng |
|---|---|
| `recode watch [path] [--poll]` | Theo dõi project ở foreground: baseline, snapshot theo file event (debounce 1.5s, maxWait 10s), theo dõi `.git/HEAD` + reflog, heartbeat, GC mỗi giờ |
| `recode save [-m msg] [--trigger manual\|agent-hook] [--quiet]` | Snapshot thủ công |
| `recode list [--pinned] [--since 2h] [--file path] [-n N]` | Liệt kê snapshot (mới nhất trước) |
| `recode diff <id> [--against current\|HEAD\|<id>] [--stat] [-- path...]` | Khác biệt; `-` = trong snapshot, `+` = bên so sánh |
| `recode show <id> [-- path]` | Thông tin snapshot, hoặc bytes chính xác của một file |
| `recode restore <id> [-- path...] [--yes] [--to dir] [--delete-extra]` | Khôi phục; luôn snapshot + pin trạng thái hiện tại trước (`pre-restore`) |
| `recode pin <id> [-m reason]` / `recode unpin <id>` | Pin / bỏ pin |
| `recode gc [--dry-run]` | Dọn theo retention |
| `recode context [--md\|--json]` | Tóm tắt chuẩn hóa cho AI |
| `recode alerts [--all] [--resolve <id\|all>]` | Xem / bỏ qua alert auto-pin |

Tùy chọn chung: `--project <path>` (chọn project khác thư mục hiện tại, kể cả project đã bị xóa). Mọi lệnh đọc có `--json` với `schemaVersion`.
Id snapshot dạng `rc_MMDD_HHmmss` (giờ địa phương, trùng giây thì thêm `_2`); có thể gõ tắt phần đầu duy nhất, hoặc `latest`.

Project bị `rm -rf` (kể cả `.git`):

```bash
recode list --project "D:\code\my app"
recode restore latest --project "D:\code\my app" --to "D:\code\my app (khôi phục)" --yes
```

## Thiết kế lưu trữ

```text
~/.recode/                        (đổi bằng biến môi trường RECODE_HOME)
├── config.json                   cấu hình (ghi mặc định ở lần chạy đầu)
└── repos/<repo-id>/              repo-id = sha256(đường dẫn chuẩn hóa)[:16]
    ├── store.git/                bare repo chứa snapshot
    ├── index                     index riêng, không đụng index của người dùng
    ├── meta.json                 đường dẫn project, trạng thái pin / covered, cảnh báo
    ├── alerts.json               alert auto-pin: open → acknowledged → resolved, hết hạn 24h
    └── watch.json                PID + heartbeat của `recode watch` đang chạy
```

Các điểm đã chốt khác/chi tiết hơn so với spec:

- **Snapshot là commit không có parent**, mỗi cái một ref `refs/recode/snaps/<id>`; thứ tự logic nằm trong metadata (`previousId`). Nếu nối parent chain thì GC theo thời gian không thể giải phóng dung lượng (snapshot mới giữ snapshot cũ qua parent).
- Metadata bất biến nằm trong commit message (JSON); trạng thái thay đổi được (`pinned`, `pinReason`, `coveredAt`) nằm trong `meta.json`.
- **Byte-exact:** store đặt `core.autocrlf=false` và `info/attributes` = `* -text -crlf -eol -filter -ident -working-tree-encoding`, nên CRLF, LFS filter, `.gitattributes` của project không làm biến đổi nội dung.
  Hệ quả: với project dùng `autocrlf`, tree snapshot có thể không trùng tree commit → không được đánh dấu `covered` → giữ lâu hơn (an toàn).
- Ignore = `.gitignore` của project + `core.excludesFile` + `.git/info/exclude` của project + danh sách mặc định của spec + `snapshot.extraIgnore`.
- File > 5MB, repo git lồng bên trong và file không đọc được (bị khóa) được **bỏ qua kèm cảnh báo**, snapshot vẫn tạo được.
- Diff với `HEAD` đọc object của người dùng qua `GIT_ALTERNATE_OBJECT_DIRECTORIES` chỉ trong lúc chạy lệnh, không ghi alternates cố định (store vẫn sống khi `.git` bị xóa).
- Mọi lệnh git đọc repo người dùng chạy với `GIT_OPTIONAL_LOCKS=0`; không bao giờ ghi vào `.git` hay index của người dùng.

### Auto-pin (spec 4C)

So snapshot mới với snapshot trước; khớp một luật → pin snapshot **trước** và tạo alert:

1. Một file > 20 dòng giảm xuống dưới 50% số dòng (file > 20 dòng bị xóa hẳn cũng tính).
2. Số dòng xóa ròng > 30% tổng số dòng trước đó của các file có thay đổi, và >= 50 dòng (không báo lại nếu luật 1 đã giải thích hết).
3. >= 3 file bị xóa (rename không tính).
4. Reflog HEAD có `reset` / `checkout` / `switch` kể từ snapshot trước, trong khi snapshot trước có thay đổi chưa commit.

Snapshot `pre-restore` luôn được pin. Snapshot tạo ngay sau restore (`trigger: restore`) không chạy luật auto-pin.

### Retention (spec 4D)

< 2 giờ: giữ hết · 2–24 giờ: 1 bản / 15 phút · 1–7 ngày: 1 bản / giờ · > 7 ngày: xóa.
Snapshot mới nhất luôn giữ. Bản pin giữ 14 ngày kể từ lúc pin. Snapshot có tree trùng một commit (reachable từ ref bất kỳ) được đánh dấu `covered`, bị xóa sau 24 giờ ân hạn; nếu commit đó biến mất (reset, xóa `.git`) thì mất dấu `covered`.

## Test

```bash
bun run typecheck
bun run test                               # unit + integration (7A.1–8, 10)
RECODE_SLOW_TESTS=1 npx vitest run         # thêm biến thể 30s ghi liên tục với timing thật của spec
```

Integration test chạy CLI thật trên repo git tạm nằm trong thư mục `dự án có dấu & khoảng trắng`, `RECODE_HOME` tạm, cấu hình git global được cô lập.
Test file bị khóa (7A.10) chỉ chạy trên Windows — CI chạy ma trận Windows / macOS / Linux.
