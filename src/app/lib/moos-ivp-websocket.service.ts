import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

@Injectable({
    providedIn: 'root'
})
export class MoosIvpWebsocketService {
    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private maxReconnectDelay = 30000; // 30 seconds max
    private baseReconnectDelay = 1000; // Start with 1 second  
    private reconnectTimer: any = null;
    private lastMessageTime: number = 0;
    private heartbeatCheckInterval: any = null;
    // iWebSocket sends telemetry 20 times a second, so 10 s of silence is a
    // dead link, not a quiet one.
    private heartbeatTimeout = 10000;
    private heartbeatSendInterval: any = null;
    // The boat returns to base when it hears nothing from the UI for
    // comms_loss_timeout (30 s by default) - a heartbeat every 5 s keeps a
    // healthy link well clear of that.
    private heartbeatSendFrequency = 5000;
    private lastHeartbeatSent = 0;
    private closingStale = false;

    /**
     * Telemetry older than this means the link is in trouble. Commands are not
     * sent then: TCP would hold them and deliver them whenever the link comes
     * back, by which time the boat may be doing something else entirely -
     * returning to base after a comms loss, for one.
     */
    public static readonly STALE_MS = 3000;

    // Observable connection state
    public connectionState$ = new BehaviorSubject<ConnectionState>('disconnected');

    // Observable data stream
    public messages$ = new Subject<string>();

    // Commands refused because the link to the USV was stale
    public refused$ = new Subject<string>();

    // Connection info
    public url: string = '';

    constructor() {
        // Start heartbeat checker
        this.startHeartbeatCheck();
        // Start heartbeat sender
        this.startHeartbeatSender();
    }

    /**
     * Connect to WebSocket server with automatic reconnection
     */
    connect(url: string): void {
        if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
            console.log('[MoosIvpWS] Already connected or connecting, skipping...');
            return;
        }

        this.url = url;
        const state: ConnectionState = this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting';
        this.connectionState$.next(state);

        console.log(`[MoosIvpWS] ${state === 'connecting' ? 'Connecting' : 'Reconnecting'} to ${url} (attempt ${this.reconnectAttempts + 1})`);

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                console.log('[MoosIvpWS] Connection established');
                this.connectionState$.next('connected');
                this.reconnectAttempts = 0; // Reset on successful connection
                this.lastMessageTime = Date.now();
            };

            this.ws.onmessage = (event: MessageEvent) => {
                this.lastMessageTime = Date.now();
                // Heartbeats ride on the telemetry as well as on the timer: a
                // browser throttles timers in a background tab (to once a
                // minute after a while), but not incoming messages.
                if (Date.now() - this.lastHeartbeatSent >= this.heartbeatSendFrequency) {
                    this.sendHeartbeat();
                }
                this.messages$.next(event.data);
            };

            this.ws.onerror = (error) => {
                console.error('[MoosIvpWS] WebSocket error:', error);
                this.connectionState$.next('error');
            };

            this.ws.onclose = (event: CloseEvent) => {
                console.log(`[MoosIvpWS] Connection closed. Code: ${event.code}, Reason: ${event.reason}, Clean: ${event.wasClean}`);
                this.connectionState$.next('disconnected');

                // Only auto-reconnect if close was not clean (unexpected
                // disconnection) - or if it was our own close of a stale link,
                // which completes cleanly when the server is still there.
                if (!event.wasClean || this.closingStale) {
                    this.closingStale = false;
                    this.scheduleReconnect();
                }
            };

        } catch (error) {
            console.error('[MoosIvpWS] Failed to create WebSocket:', error);
            this.connectionState$.next('error');
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );

        console.log(`[MoosIvpWS] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect(this.url);
        }, delay);
    }

    /**
     * Send message to WebSocket server
     */
    send(message: string): boolean {
        if (this.ws?.readyState === WebSocket.OPEN && !this.isLinkFresh()) {
            console.warn(`[MoosIvpWS] Not sent, no data from the USV for ${this.lastMessageAge()} ms: ${message}`);
            this.refused$.next(message);
            return false;
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(message);
                if (!message.startsWith('HEARTBEAT_PING=')) {
                    console.log(`[MoosIvpWS] Sent: ${message}`);
                }
                return true;
            } catch (error) {
                console.error('[MoosIvpWS] Error sending message:', error);
                return false;
            }
        } else {
            console.warn('[MoosIvpWS] Cannot send message: WebSocket not connected');
            return false;
        }
    }

    /**
     * Disconnect from WebSocket server
     */
    disconnect(): void {
        console.log('[MoosIvpWS] Disconnecting...');

        // Clear reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Close WebSocket
        if (this.ws) {
            this.ws.close(1000, 'User requested disconnect'); // Clean close
            this.ws = null;
        }

        this.connectionState$.next('disconnected');
        this.reconnectAttempts = 0;
    }

    /**
     * Check for stale connection (no messages received within timeout)
     */
    private startHeartbeatCheck(): void {
        this.heartbeatCheckInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                const timeSinceLastMessage = Date.now() - this.lastMessageTime;

                if (timeSinceLastMessage > this.heartbeatTimeout) {
                    console.warn(`[MoosIvpWS] No messages received for ${timeSinceLastMessage}ms, connection may be stale`);
                    // Force reconnect
                    this.closingStale = true;
                    this.ws.close(4001, 'Heartbeat timeout');
                }
            }
        }, 2000);
    }

    /**
     * Send periodic heartbeat messages to backend to keep connection alive
     */
    private startHeartbeatSender(): void {
        this.heartbeatSendInterval = setInterval(() => {
            if (Date.now() - this.lastHeartbeatSent >= this.heartbeatSendFrequency) {
                this.sendHeartbeat();
            }
        }, 1000);
    }

    /**
     * Heartbeat to iWebSocket, only while telemetry is coming in. With the
     * link to the boat broken one way, the boat must not go on hearing from a
     * UI that can no longer see it: going quiet lets its comms-loss watchdog
     * take the boat home.
     */
    private sendHeartbeat(): void {
        if (this.ws?.readyState === WebSocket.OPEN && this.isLinkFresh()) {
            this.lastHeartbeatSent = Date.now();
            this.send(`HEARTBEAT_PING=${this.lastHeartbeatSent}`);
        }
    }

    /** milliseconds since the last message from the USV */
    lastMessageAge(): number {
        return this.lastMessageTime ? Date.now() - this.lastMessageTime : Infinity;
    }

    /** whether telemetry is arriving from the USV */
    isLinkFresh(): boolean {
        return this.lastMessageAge() <= MoosIvpWebsocketService.STALE_MS;
    }

    /**
     * Get current connection state
     */
    getConnectionState(): ConnectionState {
        return this.connectionState$.value;
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Cleanup service on destroy
     */
    ngOnDestroy(): void {
        if (this.heartbeatCheckInterval) {
            clearInterval(this.heartbeatCheckInterval);
        }
        if (this.heartbeatSendInterval) {
            clearInterval(this.heartbeatSendInterval);
        }
        this.disconnect();
    }
}
