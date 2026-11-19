Follow native Promptobus runs beside your BB threads on a board: each active run is a lane, each pipeline step a column, and each piece of work a card in the step that holds it. A card shows who works on the piece, their latest status and whether they are stalled, asking or have unread mail. Click it for the piece's history and, for a BB participant, a button that opens its thread. Raw JSON remains under Diagnostics.

Configure an enrolled host, an owned task store and a native state directory in Settings. The board needs no selection. Owner notifications watch one selected run; that selection persists across page remounts and plugin reloads. Pause stops observation; resume reads fresh data while native work continues independently.

This plugin requires BB 0.50 from 0.50.1, Plugin SDK 0.6.157 or newer and Node 26 or newer. Optional owner notifications wake the explicitly bound BB owner for new questions, results and reviews. They work while the panel is closed, preserve unread mail and do not grant permissions. The plugin does not ACK, launch, recover or stop actors. Recorded activity does not establish process liveness. Full native transcripts, private prompts and command output are unavailable. A result or review does not establish owner acceptance.

The dashboard and owner-notification service ship together. Source checks do not establish live visual acceptance.
