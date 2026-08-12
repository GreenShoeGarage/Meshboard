# MESHBOARD v0.3.0 — Messaging Acceptance Test Plan

Use at least two Meshtastic nodes on a common channel. A third node is useful for direct-conversation switching.

## A. Conversation navigation

1. Connect node A and reach CONNECTED.
2. Open MESSAGES.
3. Verify configured channels appear under CHANNELS.
4. Verify known peer nodes appear under DIRECT.
5. Select a channel; verify destination becomes Broadcast.
6. Select a direct peer; verify destination becomes that peer.
7. Switch back to the channel and verify selection is stable.

## B. Draft persistence

1. Type text in channel 0 without sending.
2. Switch to a direct conversation.
3. Type different text.
4. Return to channel 0; original draft must remain.
5. Refresh the browser; both drafts must remain.
6. Send one draft; only that conversation's draft should clear.

## C. Channel message send

1. Compose a valid message.
2. Press SEND.
3. Message must appear immediately as SENDING.
4. When the SDK send resolves successfully, state must become ACKNOWLEDGED.
5. Packet ID should populate.
6. If a matching raw packet is retained, the inspector must expose it.

## D. Inbound message

1. Send from node B to the same channel.
2. Message must appear as RECEIVED.
3. Sender must resolve to the known node name where available.
4. RSSI/SNR should appear only when a matching observed packet contains them.
5. No symmetric-link claim should be made from those values.

## E. Direct message

1. Select node B under DIRECT.
2. Send a direct message.
3. Confirm message is associated only with the direct conversation.
4. Confirm channel conversation does not duplicate it.
5. Receive a direct reply and verify the same thread is used.

## F. Failure and retry

1. Create a send failure by disconnecting or otherwise making the transport unavailable during a send.
2. Message must remain visible as FAILED.
3. Failure reason must be retained.
4. Reconnect the radio.
5. Select the failed message and press RETRY MESSAGE.
6. Attempt counter must increment.
7. On success, state must become ACKNOWLEDGED and the failure reason clear.

## G. Search and filters

Verify search by:

- message text
- node name
- packet ID
- state text

Verify filters:

- All states
- Sending
- Acknowledged
- Failed
- Received

## H. Unread behavior

1. Open channel 0, then switch to channel 1.
2. Receive a channel-0 message.
3. Channel 0 should show an unread count.
4. Select channel 0; unread count should clear.
5. Repeat with a direct conversation.
6. Refresh the browser and verify read markers persist.

## I. Packet evidence

1. Select a message with a linked packet.
2. Verify packet record ID, PortNum, hops, RSSI/SNR where available.
3. Press VIEW PACKET RECORD.
4. PACKETS must open with the corresponding packet selected.

## J. Export

1. Export Messages CSV.
2. Verify state, sender, destination, channel, packet ID, attempts, text, RSSI/SNR, hops, and failure reason columns.
3. Export Project JSON.
4. Re-import into a fresh browser/project and verify messaging state survives.

## K. Regression — radio reliability

Repeat the v0.2 tests:

- operator disconnect
- reconnect
- USB unplug/replug
- ESP32 reset
- browser refresh
- busy serial port
- bounded retry exhaustion

No messaging failure is allowed to clear the project.
