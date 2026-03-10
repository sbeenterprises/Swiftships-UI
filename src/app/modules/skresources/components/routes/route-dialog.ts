/** Route Details Dialog Component **
 ********************************/

import { Component, OnInit, Inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { SKRoute } from '../../resource-classes';

/********* RouteDialog **********
  data: {
    route: SKRoute
  }
***********************************/
@Component({
  selector: 'ap-routedialog',
  imports: [
    FormsModule,
    MatInputModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule
  ],
  template: `
    <div class="_ap-route">
      <div style="display:flex;">
        <div style="padding: 15px 0 0 10px;">
          <mat-icon class="icon-route" svgIcon="route"></mat-icon>
        </div>
        <div>
          <h1 mat-dialog-title>Route Details</h1>
        </div>
      </div>

      <mat-dialog-content>
        <div>
          <div style="padding-left: 10px;">
            <div>
              <mat-form-field floatLabel="always">
                <mat-label>Name</mat-label>
                <input
                  matInput
                  #inpname="ngModel"
                  type="text"
                  required
                  [readonly]="readOnly"
                  [(ngModel)]="name"
                />
                @if(inpname.invalid && (inpname.dirty || inpname.touched)) {
                <mat-error> Please enter a name.</mat-error>
                }
                @if(isDuplicate) {
                <div style="color: #f44336; font-size: 12px; margin-top: 4px;">
                  ⚠ This name already exists.
                </div>
                }
              </mat-form-field>
            </div>
            <div>
              <mat-form-field floatLabel="always">
                <mat-label>Description</mat-label>
                <textarea
                  matInput
                  rows="3"
                  #inpcmt="ngModel"
                  [readonly]="readOnly"
                  [(ngModel)]="description"
                >
                </textarea>
              </mat-form-field>
            </div>
          </div>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions>
        <div style="text-align:center;width:100%;">
          @if(!readOnly) {
          <button
            mat-raised-button
            [disabled]="inpname.invalid || readOnly || isDuplicate"
            (click)="handleClose(true)"
          >
            SAVE
          </button>
          }
          <button mat-raised-button (click)="handleClose(false)">CANCEL</button>
        </div>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      ._ap-route {
        min-width: 300px;
      }
    `
  ]
})
export class RouteDialog implements OnInit {
  protected name: string;
  protected description: string;
  protected readOnly = false;
  private existingNames: string[] = [];

  constructor(
    private dialogRef: MatDialogRef<RouteDialog>,
    @Inject(MAT_DIALOG_DATA)
    protected data: {
      route: SKRoute;
      existingNames?: string[];
    }
  ) { }

  ngOnInit() {
    this.name = this.data.route.name ?? '';
    this.description = this.data.route.description ?? '';
    this.readOnly =
      (this.data.route.feature as any)?.properties?.readOnly ?? false;
    this.existingNames = (this.data.existingNames ?? []).map(n => n.toLowerCase());
  }

  get isDuplicate(): boolean {
    return this.name?.trim().length > 0 &&
      this.existingNames.includes(this.name.trim().toLowerCase());
  }

  handleClose(save: boolean) {
    if (save) {
      this.data.route.name = this.name;
      this.data.route.description = this.description;
    }
    this.dialogRef.close({ save: save, route: this.data.route });
  }
}
