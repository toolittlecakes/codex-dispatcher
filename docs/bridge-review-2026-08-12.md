# Bridge review findings — 2026-08-12

Контекст: dispatcher эмулирует VS Code host для webview Codex-экстеншна. Экстеншн считается корректным; все баги итогового вебаппа ищем в бридже (`src/extension-webview.ts` + `src/server.ts`). Ниже — зафиксированные проблемы по итогам ревью, ранжированы по группам. Статус: not started, если не отмечено иное.

Прошло независимое ревью субагентом (одна итерация, 2026-08-12): все findings подтверждены фактически, поправки внесены inline (A6 понижен, C3-коллизия кук повышена), добавлена секция E с пропущенными изначально проблемами.

## A. Fidelity бриджа к VS Code host (высокий приоритет)

### A1. Два несинхронизированных канала доставки сообщений в webview

В VS Code webview↔host — один упорядоченный FIFO-канал `postMessage`. В бридже два: ответы на host-message приходят в POST response (`deliver(body.messages)` в shim, `extension-webview.ts:986-1005`), broadcast'ы — через SSE (`:1023`). Плюс каждый `postMessage` из webview — отдельный параллельный fetch: порядок обработки на сервере и порядок доставки ответов не гарантирован. Симптом: редкие гонки состояния/стрима, которых нет в VS Code (notification о turn приходит раньше ответа на запрос, который его запустил, и т.п.).

Направление фикса: один упорядоченный канал (например, весь трафик через один WebSocket с seq-номерами) либо очередь на клиенте (сериализовать `sendHostMessage`) + доставка ответов через тот же SSE-поток, чтобы сервер контролировал порядок.

### A2. Потеря событий при SSE reconnect

EventSource авто-реконнектится, но нет Last-Event-ID/буфера: всё, что broadcast'нулось во время разрыва (блокировка телефона убивает соединение), теряется. Replay при реконнекте (`buildExtensionEventReplayMessages`, `server.ts:781`) отдаёт только thread-stream снапшоты; `mcp-notification` и `mcp-request` (pending approvals!) от app-server не реплеятся — тихая потеря. Дополнительно: шим не вешает `events.onerror` — перманентная смерть SSE-соединения тоже тихая для пользователя.

Направление фикса: ring-buffer исходящих сообщений с event id + `Last-Event-ID` при реконнекте, либо полный state-resync протокол при реконнекте.

### A3. `handleMcpResponse` выбрасывает error из ответа webview — DONE

`extension-webview.ts:670`: `respondToServerRequest(String(response.id), response.result ?? null)` — если webview ответил на server request с `error`, app-server получает успешный `result: null`. Молчаливое искажение. `CodexAppServer.respondToServerRequest` вообще не умеет передавать error.

Фикс: пробрасывать `error` в JSON-RPC ответ app-server'у.

### A4. `handleExternalFetch` не эквивалентен настоящему fetch

- При `!response.ok` тело ответа выбрасывается, возвращается error со `statusText` (`extension-webview.ts:1262`). Реальный fetch отдаёт body и на 4xx/5xx; экстеншн может парсить JSON ошибки.
- Жёсткий `AbortSignal.timeout(10_000)` на все внешние запросы — долгие запросы отваливаются.
- Полная буферизация ответа — стриминговые ответы не работают.

Фикс: возвращать non-ok ответы с телом как success-с-статусом (как ведёт себя реальный host), пересмотреть таймаут, зафиксировать решение по стримингу (если не нужен — явно задокументировать).

### A5. Version coupling с экстеншном без контракта

Бридж жёстко завязан на контракт конкретной версии экстеншна: списки `vscode://codex/*` endpoints (`handleVSCodeRequest`), follower-методы, `methodVersions` (`thread-stream-state-changed: 6`, захардкожен также в `server.ts:801`), wham/statsig стабы. При этом `resolveExtensionWebviewRoot` берёт последнюю установленную версию экстеншна — автообновление ломает бридж молча (`Unsupported vscode://codex/...`). Уже копятся version-specific хаки: strip `workspace_dependencies` (`extension-webview.ts:1397`), кэш `experimentalFeature/enablement/set` (`:627`). Мелочь рядом: `extensionVersion()` (`extension-webview.ts:1611`) пересканирует диск и может разойтись с `webviewRoot`, зарезолвленным при старте.

Фикс: пиннинг поддерживаемой версии экстеншна (диапазон) с явной ошибкой при несовпадении + smoke/contract-тест против реально установленной версии.

### A6. Debounce вместо throttle в `scheduleDispatcherOwnedRefresh` (понижен: подсистема сейчас мертва, см. E3)

`server.ts:723`: каждый notification ресетит 120ms таймер. При стриме чаще 120ms refresh откладывается до паузы — starvation: VS Code-follower dispatcher-owned треда видит фриз, потом скачок. Поправка по итогам ревью: `dispatcherOwnedConversations` наполняется только из мёртвого WS-протокола (см. B1/E3), так что симптом сейчас недостижим — чинить вместе с решением по E3.

Фикс: trailing throttle (гарантированный refresh не реже, чем раз в N ms), не debounce.

## B. Мёртвый код

### B1. `canHandle` всегда true → `public/` и WS-протокол недостижимы

`extension-webview.ts:168`: `canHandle` = `pathname.startsWith("/")` — всегда true. Следствия:

- `serveStatic` и весь `public/` (legacy UI: `app.js`, `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, `approval-requests.js`) не отдаются никогда. Исключение — `json-patch.js`, который сервер импортирует напрямую.
- PWA manifest и service worker не отдаются: если PWA-установка заявлена как фича — она сломана.
- Почти весь WS-протокол `ClientMessage` в `server.ts` (~400 строк: listThreads/startTurn/rotateToken/...) обслуживает мёртвый UI.

Решение нужно явное: либо выпилить legacy UI + мёртвую часть WS-протокола (и перенести `json-patch.js` в `src/`), либо это баг routing'а и PWA-ассеты надо начать отдавать. Blast radius больше, чем кажется: вместе с WS-протоколом мертва вся dispatcher-owner подсистема — см. E3.

## C. Security

### C1. Relay: response-фреймы не привязаны к сессии отправителя

`relay-server.ts:94-96`: `message(_ws, raw)` игнорирует, от какого сокета пришёл фрейм. Любой авторизованный dispatcher может слать `http-response-*` с чужим requestId (cross-tenant response injection). Сдерживается только энтропией `req_<24 bytes>`.

Фикс: в `handleDispatcherFrame` проверять `pending.dispatcherSessionId === ws.data.session.id`.

### C2. `pendingOAuthByState` без TTL-очистки

`relay-server.ts:39`: `createdAt` пишется, но не проверяется; записи брошенных логинов копятся вечно. Фикс: TTL-чистка (например, при каждом start/callback выкидывать записи старше 15 минут).

### C3. Мелочи

- Сравнение dispatcher-токена не constant-time (`extension-webview.ts:240-247`, а также `/ws` в `server.ts:199`) — заменить на `crypto.timingSafeEqual`.
- Кука дispatcher'а без `Secure`/`Max-Age` (`authCookie`, `extension-webview.ts:1658`). Нюанс: локальный сценарий — http по LAN, `Secure` там сломает вход; ставить флаг только когда запрос пришёл через relay/https.
- **Коллизия имён кук — повышена по итогам ревью, достижима.** Имя `codex_dispatcher_session` совпадает у relay (Domain-кука на `.codex-dispatcher.app`, `relay-server.ts:496`) и дispatcher'а (`extension-webview.ts:54`). Если пользователь откроет через relay URL с `?token=` (dispatcher отдаст свой `set-cookie` в `serveIndex`, `extension-webview.ts:263-265`), браузер получит две одноимённые куки, и `cookieValue` relay (`relay-server.ts:507`) возьмёт первую попавшуюся → ломается relay-авторизация. Переименовать одну из кук.

## D. Архитектура / стиль

### D1. Module-level mutable state в `extension-webview.ts`

`globalState`/`persistedAtomState`/`sharedObjectState`/`activeExtensionStatePath` (`extension-webview.ts:57-60`) — глобальные синглтоны вне класса. Второй инстанс `ExtensionWebview` (тесты) клобает первый; конструктор молча перезагружает глобальное состояние. Фикс: перенести в поля класса / отдельный state-объект, инжектируемый в конструктор.

### D2. Server импортирует untyped `.js` из `public/`

`server.ts:4`: `import ... from "../public/json-patch.js"`. Shared-модуль должен жить в `src/` с типами; в `public/` (если public остаётся) — build-копия или реэкспорт.

### D3. Дублирование helpers

`cookieValue`, `contentType`, `isRecord`/`isJsonObject`, `jsonResponse`, `toError` продублированы в 2-3 файлах. Вынести в общий модуль.

### D4. Захардкоженная версия clientInfo

`codex-app-server.ts:126`: `version: "0.0.1"` при пакете 0.0.2. Брать из package.json / build-константы.

## E. Добавлено по итогам ревью субагентом (пропущено в первом проходе)

### E1. Relay: `http-response-error` после `http-response-start` вешает браузерный стрим

`relay-server.ts:373-381`: при error-фрейме вызывается `pending.reject`, но если ответ уже отдан стримом (после `http-response-start`), промис resolved и reject — no-op; `controller.error()` не вызывается, entry удаляется из map → браузерный ответ висит вечно (пост-start таймаута нет, `startTimeout` очищен при resolve). relay-client реально шлёт error-фрейм посреди стрима, если чтение локального body упало (`relay-client.ts:241-249`). Для сравнения: `closePendingRequestsForDispatcher` (`relay-server.ts:398-406`) делает это правильно через `controller.error()`.

Фикс: в case `http-response-error` — если `pending.controller` есть, звать `controller.error(...)`, иначе `reject`.

### E2. `thread-follower-edit-last-user-turn` не поддержан для dispatcher-owned тредов

Метод есть в `followerRequestMethods` (`server.ts:81`) и в мостах webview (`extension-webview.ts:68`, `:101-103`), но отсутствует в `dispatcherOwnerRequestMethods` (`server.ts:90-103`) и в switch `handleDispatcherOwnerRequest` — dispatcher не регистрирует IPC-хендлер для него. VS Code-follower, редактирующий последний user turn на dispatcher-owned треде, получит `no-handler-for-request`/`no-client-found`. (Примечание: ревьюер описал механизм неверно — метода нет в set вообще, а не «нет case в switch»; проверено grep'ом. Функциональный пробел реальный. Смягчение: подсистема сейчас дремлет, см. E3.)

### E3. Blast radius B1: вся dispatcher-owner подсистема мертва

`dispatcherOwnedConversations` пополняется только из WS-путей legacy UI (`server.ts:330, 349, 383, 412` → `:519, 709, 718`), которые недостижимы (B1). Треды, стартованные из webview, идут через `mcp-request` → `thread/start` напрямую и owner'ом не помечаются. Значит `handleDispatcherOwnerRequest`, `scheduleDispatcherOwnedRefresh`, replay owned-снапшотов (`server.ts:796-804`) и `dispatcher-owner.ts` сейчас не активируются — заявленный в TASKS.md пункт 3 «Dispatcher owner mode — done» фактически не работает через актуальный UI. Решение по B1 обязано включать судьбу этой подсистемы (~300+ строк сверх legacy UI): либо помечать webview-стартованные треды owner'ами, либо резать.

### E4. Нарушение инварианта «один webview»: несколько вкладок/устройств

VS Code гарантирует один webview-инстанс; в бридже каждая вкладка — полноценный клиент. `mcp-request` (аппрувы) броадкастится всем SSE-клиентам (`extension-webview.ts:218-228`), а ответить может каждая вкладка: второй `respondToServerRequest` кидает «No pending app-server request» (`codex-app-server.ts:160`) → host-message-error 500 во второй вкладке. Плюс дрейф состояния между вкладками (ответы на host-запросы видит только запросившая вкладка). Нужно решение: либо single-active-client (остальные read-only/kick), либо дедупликация ответов на server requests.

### E5. Асимметрия типов id в mcp-мостах — DONE

`handleMcpRequest` требует строковый `request.id` (`extension-webview.ts:595`), `handleMcpResponse` принимает string|number (`:667`). Числовой id запроса от экстеншна даст «Invalid mcp-request payload». Унифицировать.

## Приоритизация (обновлена после ревью)

1. A1, A2 — источник будущих «на телефоне отстаёт/зависает стейт» багрепортов.
2. A5 — сломается при первом автообновлении экстеншна.
3. B1 + E3 — одно решение: судьба legacy UI, PWA и dispatcher-owner подсистемы.
4. E4 — реальный multi-tab сценарий на телефоне+ноуте, ломает аппрувы.
5. A3, A4, C1, E1 — точечные фиксы, дешёвые.
6. A6, E2 — вместе с решением по E3.
7. C2, C3, D1-D4, E5 — по остаточному принципу.
