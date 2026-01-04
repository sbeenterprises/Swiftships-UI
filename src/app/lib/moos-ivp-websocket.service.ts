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
    private heartbeatTimeout = 60000; // 60 seconds - match server timeout

    // Observable connection state
    public connectionState$ = new BehaviorSubject<ConnectionState>('disconnected');

    // Observable data stream
    public messages$ = new Subject<string>();

    // Connection info
    public url: string = '';

    constructor() {
        // Start heartbeat checker
        this.startHeartbeatCheck();
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
                this.messages$.next(event.data);
            };

            this.ws.onerror = (error) => {
                console.error('[MoosIvpWS] WebSocket error:', error);
                this.connectionState$.next('error');
            };

            this.ws.onclose = (event: CloseEvent) => {
                console.log(`[MoosIvpWS] Connection closed. Code: ${event.code}, Reason: ${event.reason}, Clean: ${event.wasClean}`);
                this.connectionState$.next('disconnected');

                // Only auto-reconnect if close was not clean (unexpected disconnection)
                if (!event.wasClean) {
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
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(message);
                console.log(`[MoosIvpWS] Sent: ${message}`);
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
                    this.ws.close(4001, 'Heartbeat timeout');
                }
            }
        }, 10000); // Check every 10 seconds
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
        this.disconnect();
    }
}
