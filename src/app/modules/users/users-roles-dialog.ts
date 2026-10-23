/** Users & Roles dialog **
 * Add, change and remove Signal K users and their SwiftShips C2 role in one
 * place. Everything goes through Signal K's own admin API with the caller's
 * login, so only Signal K admins can use it (Signal K checks that, not this
 * page). Roles are saved in the SwiftShips C2 plugin settings
 * (configuration.roles); saving restarts the plugin, which rewrites the
 * roles file iWebSocket reads.
 ********************************/

import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Observable } from 'rxjs';
import { AppFacade } from 'src/app/app.facade';

/** rxjs 6 has no firstValueFrom: the first value as a promise */
const firstValueFrom = <T>(o: Observable<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const sub = o.subscribe({
      next: (v) => { resolve(v); setTimeout(() => sub.unsubscribe()); },
      error: reject,
      complete: () => reject(new Error('no response'))
    });
  });

type SkType = 'readonly' | 'readwrite' | 'admin';
type C2Role = '' | 'viewer' | 'planner' | 'operator' | 'supervisor';

interface UserRow {
  userId: string;
  type: SkType;
  role: C2Role; // '' = default for the Signal K type
  origType: SkType;
  origRole: C2Role;
}

/** plugin id of the SwiftShips C2 plugin (kept from its old name) */
const PLUGIN_ID = 'swiftships-ui';

const DEFAULT_ROLE: { [t in SkType]: C2Role } = {
  readonly: 'viewer',
  readwrite: 'operator',
  admin: 'supervisor'
};

@Component({
  selector: 'c2-users-roles-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatProgressBarModule
  ],
  template: `
    <div class="ur">
      <div class="ur-head">
        <mat-icon>manage_accounts</mat-icon>
        <span class="ur-title">Users &amp; Roles</span>
        <button mat-icon-button (click)="dialogRef.close()"><mat-icon>close</mat-icon></button>
      </div>
      @if (busy) { <mat-progress-bar mode="indeterminate"></mat-progress-bar> }
      @if (error) { <div class="ur-error">{{ error }}</div> }

      <mat-dialog-content>
        <table class="ur-table">
          <tr>
            <th>User</th>
            <th>Signal K access</th>
            <th>Boat role</th>
            <th></th>
          </tr>
          @for (u of users; track u.userId) {
          <tr [class.ur-dirty]="dirty(u)">
            <td class="ur-user">
              {{ u.userId }}
              @if (u.userId === me) { <span class="ur-me">(you)</span> }
            </td>
            <td>
              <mat-select [(ngModel)]="u.type" [disabled]="busy || u.userId === me"
                (selectionChange)="typeChanged(u)"
                [matTooltip]="u.userId === me ? 'You cannot change your own access' : ''">
                <mat-option value="readonly">Read only</mat-option>
                <mat-option value="readwrite">Read/Write</mat-option>
                <mat-option value="admin">Admin</mat-option>
              </mat-select>
            </td>
            <td>
              <mat-select [(ngModel)]="u.role" [disabled]="busy || u.type === 'readonly'"
                [matTooltip]="u.type === 'readonly' ? 'A read-only account is always a Viewer' : ''">
                <mat-option value="">{{ roleLabel(defaultRole(u.type)) }} (default)</mat-option>
                <mat-option value="viewer">Viewer</mat-option>
                <mat-option value="planner">Planner</mat-option>
                <mat-option value="operator">Operator</mat-option>
                <mat-option value="supervisor">Supervisor</mat-option>
              </mat-select>
            </td>
            <td class="ur-actions">
              <button mat-icon-button matTooltip="Set a new password" [disabled]="busy"
                (click)="setPassword(u)"><mat-icon>key</mat-icon></button>
              <button mat-icon-button matTooltip="Remove this user" [disabled]="busy || u.userId === me"
                (click)="remove(u)"><mat-icon>delete</mat-icon></button>
            </td>
          </tr>
          }
        </table>

        <div class="ur-add">
          <div class="ur-sub">Add a user</div>
          <div class="ur-add-row">
            <mat-form-field class="ur-f">
              <mat-label>User name</mat-label>
              <input matInput [(ngModel)]="newUser" autocomplete="off" />
            </mat-form-field>
            <mat-form-field class="ur-f">
              <mat-label>Password</mat-label>
              <input matInput type="password" [(ngModel)]="newPass" autocomplete="new-password" />
            </mat-form-field>
            <mat-form-field class="ur-f">
              <mat-label>Repeat password</mat-label>
              <input matInput type="password" [(ngModel)]="newPass2" autocomplete="new-password" />
            </mat-form-field>
          </div>
          <div class="ur-add-row">
            <mat-form-field class="ur-f">
              <mat-label>Signal K access</mat-label>
              <mat-select [(ngModel)]="newType">
                <mat-option value="readonly">Read only</mat-option>
                <mat-option value="readwrite">Read/Write</mat-option>
                <mat-option value="admin">Admin</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field class="ur-f">
              <mat-label>Boat role</mat-label>
              <mat-select [(ngModel)]="newRole" [disabled]="newType === 'readonly'">
                <mat-option value="">{{ roleLabel(defaultRole(newType)) }} (default)</mat-option>
                <mat-option value="viewer">Viewer</mat-option>
                <mat-option value="planner">Planner</mat-option>
                <mat-option value="operator">Operator</mat-option>
                <mat-option value="supervisor">Supervisor</mat-option>
              </mat-select>
            </mat-form-field>
            <button mat-raised-button color="primary" [disabled]="busy" (click)="add()">
              <mat-icon>person_add</mat-icon> Add user
            </button>
          </div>
        </div>

        <div class="ur-help">
          Viewer: watch only. Planner: also draw and save draft routes. Operator: may take control
          of the boat (one at a time) and press ALL STOP. Supervisor: operator who may also force a
          takeover. Signal K "Admin" is needed to manage users here; it gives no boat control by
          itself. A role change applies the next time that user connects.
        </div>
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="dialogRef.close()">Close</button>
        <button mat-raised-button color="primary" [disabled]="busy || !anyDirty()" (click)="saveChanges()">
          Save changes
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      .ur { min-width: 320px; max-width: 760px; }
      .ur-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 0 16px; }
      .ur-title { flex: 1; font-size: 18px; font-weight: 500; }
      .ur-error { margin: 8px 16px; padding: 8px 10px; border-radius: 6px;
        background: #5a1d1d; color: #ffb4b4; font-size: 13px; }
      .ur-table { width: 100%; border-collapse: collapse; }
      .ur-table th { text-align: left; font-weight: 500; font-size: 12px; opacity: 0.7; padding: 4px 6px; }
      .ur-table td { padding: 4px 6px; border-top: 1px solid rgba(128, 128, 128, 0.25); }
      .ur-table mat-select { min-width: 140px; }
      .ur-dirty td { background: rgba(31, 111, 209, 0.12); }
      .ur-user { font-weight: 500; white-space: nowrap; }
      .ur-me { font-weight: 400; opacity: 0.6; margin-left: 4px; }
      .ur-actions { white-space: nowrap; text-align: right; }
      .ur-add { margin-top: 16px; }
      .ur-sub { font-weight: 500; margin-bottom: 4px; }
      .ur-add-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .ur-f { flex: 1 1 160px; }
      .ur-help { margin-top: 8px; font-size: 12px; opacity: 0.75; line-height: 1.4; }
    `
  ]
})
export class UsersRolesDialog implements OnInit {
  protected users: UserRow[] = [];
  protected busy = false;
  protected error = '';
  protected me = '';

  protected newUser = '';
  protected newPass = '';
  protected newPass2 = '';
  protected newType: SkType = 'readwrite';
  protected newRole: C2Role = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pluginOptions: any = null;

  constructor(
    public dialogRef: MatDialogRef<UsersRolesDialog>,
    private http: HttpClient,
    private app: AppFacade
  ) {}

  ngOnInit() {
    this.load();
  }

  protected defaultRole(t: SkType): C2Role {
    return DEFAULT_ROLE[t] ?? 'viewer';
  }

  protected roleLabel(r: string): string {
    return r ? r.charAt(0).toUpperCase() + r.slice(1) : '';
  }

  protected dirty(u: UserRow): boolean {
    return u.type !== u.origType || u.role !== u.origRole;
  }

  protected anyDirty(): boolean {
    return this.users.some((u) => this.dirty(u));
  }

  protected typeChanged(u: UserRow) {
    if (u.type === 'readonly') {
      u.role = '';
    }
  }

  // ** Signal K admin API (same server, the caller's login) **

  private url(path: string): string {
    return `${this.app.serverOrigin}${path}`;
  }

  private opts() {
    const cookie = this.app.getFBToken();
    const token = this.app.skToken || (cookie && cookie !== 'null' ? cookie : '');
    return token
      ? { headers: new HttpHeaders({ Authorization: `JWT ${token}` }) }
      : { withCredentials: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private explain(err: any): string {
    if (err?.status === 401 || err?.status === 403) {
      return 'Signal K refused: only Signal K admins can manage users. Log in with an admin account.';
    }
    const body = typeof err?.error === 'string' ? err.error : err?.error?.message;
    return body || err?.message || 'Request failed';
  }

  protected async load() {
    this.busy = true;
    this.error = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status: any = await firstValueFrom(
        this.http.get(this.url('/skServer/loginStatus'), this.opts())
      );
      this.me = status?.username ?? '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any = await firstValueFrom(
        this.http.get(this.url('/skServer/security/users'), this.opts())
      );
      this.pluginOptions = await firstValueFrom(
        this.http.get(this.url(`/plugins/${PLUGIN_ID}/config`), this.opts())
      );
      const roles: Array<{ user: string; role: string }> =
        this.pluginOptions?.configuration?.roles ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.users = (Array.isArray(list) ? list : []).map((u: any) => {
        const mapped = (roles.find((r) => r.user === u.userId)?.role ?? '') as C2Role;
        const type = (u.type ?? 'readonly') as SkType;
        const role = type === 'readonly' ? '' : mapped;
        return { userId: u.userId, type, role, origType: type, origRole: role };
      });
      this.users.sort((a, b) => a.userId.localeCompare(b.userId));
    } catch (err) {
      this.error = this.explain(err);
    }
    this.busy = false;
  }

  /** Writes the roles of every user (plus any kept for users not listed)
   * into the plugin settings; Signal K restarts the plugin with them. */
  private async saveRoles(remove?: string) {
    const opts = this.pluginOptions ?? { enabled: true, configuration: {} };
    const known = new Set(this.users.map((u) => u.userId));
    const kept = (opts.configuration?.roles ?? []).filter(
      (r: { user: string }) => !known.has(r.user) && r.user !== remove
    );
    const roles = kept.concat(
      this.users
        .filter((u) => u.userId !== remove && u.role && u.type !== 'readonly')
        .map((u) => ({ user: u.userId, role: u.role }))
    );
    const body = {
      ...opts,
      enabled: opts.enabled ?? true,
      configuration: { ...(opts.configuration ?? {}), roles }
    };
    await firstValueFrom(
      this.http.post(this.url(`/plugins/${PLUGIN_ID}/config`), body, this.opts())
    );
    this.pluginOptions = body;
  }

  protected async saveChanges() {
    this.busy = true;
    this.error = '';
    try {
      for (const u of this.users.filter((x) => x.type !== x.origType)) {
        await firstValueFrom(
          this.http.put(this.url(`/skServer/security/users/${encodeURIComponent(u.userId)}`),
            { type: u.type }, this.opts())
        );
      }
      if (this.users.some((u) => u.role !== u.origRole || u.type !== u.origType)) {
        await this.saveRoles();
      }
      this.app.showMessage('Users and roles saved', false, 3000);
      await this.load();
    } catch (err) {
      this.error = this.explain(err);
      this.busy = false;
    }
  }

  protected async add() {
    const id = this.newUser.trim();
    this.error = '';
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id)) {
      this.error = 'User name: letters, digits, . _ @ - only.';
      return;
    }
    if (this.users.some((u) => u.userId === id)) {
      this.error = `${id} already exists.`;
      return;
    }
    if (this.newPass.length < 8) {
      this.error = 'Password: at least 8 characters.';
      return;
    }
    if (this.newPass !== this.newPass2) {
      this.error = 'The passwords do not match.';
      return;
    }
    this.busy = true;
    try {
      await firstValueFrom(
        this.http.post(this.url(`/skServer/security/users/${encodeURIComponent(id)}`),
          { type: this.newType, password: this.newPass }, this.opts())
      );
      const role = this.newType === 'readonly' ? '' : this.newRole;
      this.users.push({ userId: id, type: this.newType, role, origType: this.newType, origRole: '' });
      if (role) {
        await this.saveRoles();
      }
      this.app.showMessage(`User ${id} added`, false, 3000);
      this.newUser = this.newPass = this.newPass2 = '';
      this.newRole = '';
      await this.load();
    } catch (err) {
      this.error = this.explain(err);
      this.busy = false;
    }
  }

  protected async setPassword(u: UserRow) {
    const p1 = window.prompt(`New password for ${u.userId} (at least 8 characters):`);
    if (p1 === null) return;
    if (p1.length < 8) {
      this.error = 'Password: at least 8 characters.';
      return;
    }
    const p2 = window.prompt('Repeat the new password:');
    if (p2 !== p1) {
      this.error = 'The passwords do not match.';
      return;
    }
    this.busy = true;
    this.error = '';
    try {
      // Signal K 2.13's own password route looks the user up wrongly; the
      // update route sets the password the same way and works
      await firstValueFrom(
        this.http.put(this.url(`/skServer/security/users/${encodeURIComponent(u.userId)}`),
          { password: p1 }, this.opts())
      );
      this.app.showMessage(`Password changed for ${u.userId}`, false, 3000);
    } catch (err) {
      this.error = this.explain(err);
    }
    this.busy = false;
  }

  protected async remove(u: UserRow) {
    if (u.userId === this.me) return;
    if (!window.confirm(`Remove user ${u.userId}? They will no longer be able to log in.`)) return;
    this.busy = true;
    this.error = '';
    try {
      await firstValueFrom(
        this.http.delete(this.url(`/skServer/security/users/${encodeURIComponent(u.userId)}`),
          this.opts())
      );
      this.users = this.users.filter((x) => x.userId !== u.userId);
      await this.saveRoles(u.userId);   // drop any role kept for them
      this.app.showMessage(`User ${u.userId} removed`, false, 3000);
      await this.load();
    } catch (err) {
      this.error = this.explain(err);
      this.busy = false;
    }
  }
}
