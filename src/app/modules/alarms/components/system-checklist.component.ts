/***********************************
  System Checklist
  <system-checklist>
***********************************/
import {
  Component,
  ChangeDetectionStrategy,
  EventEmitter,
  Output,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatListModule } from '@angular/material/list';
import { CdkDrag } from '@angular/cdk/drag-drop';

export interface ChecklistItem {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  category: 'navigation' | 'safety' | 'communication' | 'maintenance' | 'departure';
}

@Component({
  selector: 'system-checklist',
  imports: [
    MatTooltipModule,
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatCheckboxModule,
    MatListModule,
    FormsModule,
    CdkDrag
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./system-checklist.component.css'],
  template: `
    <div class="checklist-panel" cdkDrag cdkDragHandle>
      <mat-card class="checklist-card">
        <mat-card-header>
          <mat-card-title>
            <mat-icon>playlist_add_check</mat-icon>
            System Checklist
            <button
              mat-icon-button
              class="close-button"
              (click)="handleClose()"
              matTooltip="Close"
            >
              <mat-icon>close</mat-icon>
            </button>
          </mat-card-title>
        </mat-card-header>
        
        <mat-card-content>
          <div class="checklist-progress">
            <strong>Progress: {{getCompletedCount()}}/{{checklistItems().length}}</strong>
            <div class="progress-bar">
              <div 
                class="progress-fill" 
                [style.width.%]="getProgressPercentage()"
              ></div>
            </div>
          </div>

          <div class="checklist-categories">
            @for(category of getCategories(); track category) {
            <div class="category-section">
              <h4 class="category-title">{{getCategoryTitle(category)}}</h4>
              <mat-list>
                @for(item of getItemsByCategory(category); track item.id) {
                <mat-list-item class="checklist-item">
                  <mat-checkbox
                    [checked]="item.completed"
                    (change)="toggleItem(item)"
                  >
                    <div class="item-content">
                      <span class="item-title">{{item.title}}</span>
                      @if(item.description) {
                        <span class="item-description">{{item.description}}</span>
                      }
                    </div>
                  </mat-checkbox>
                </mat-list-item>
                }
              </mat-list>
            </div>
            }
          </div>

          <div class="checklist-actions">
            <button
              mat-raised-button
              color="primary"
              (click)="resetChecklist()"
              matTooltip="Reset all items"
            >
              <mat-icon>refresh</mat-icon>
              Reset All
            </button>
            <button
              mat-raised-button
              color="accent"
              (click)="completeAll()"
              matTooltip="Mark all as complete"
            >
              <mat-icon>done_all</mat-icon>
              Complete All
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `
})
export class SystemChecklistComponent {
  @Output() closed = new EventEmitter<void>();

  protected checklistItems = signal<ChecklistItem[]>([
    {
      id: 'nav1',
      title: 'Chart Navigation System',
      description: 'Verify charts are loaded and current',
      completed: false,
      category: 'navigation'
    },
    {
      id: 'nav2',
      title: 'GPS Position Fix',
      description: 'Confirm accurate GPS positioning',
      completed: false,
      category: 'navigation'
    },
    {
      id: 'nav3',
      title: 'Course Planning',
      description: 'Route waypoints verified and set',
      completed: false,
      category: 'navigation'
    },
    {
      id: 'safety1',
      title: 'Emergency Equipment',
      description: 'Life jackets, flares, and safety gear checked',
      completed: false,
      category: 'safety'
    },
    {
      id: 'safety2',
      title: 'Bilge Pump Operation',
      description: 'Test bilge pump and emergency systems',
      completed: false,
      category: 'safety'
    },
    {
      id: 'comm1',
      title: 'VHF Radio Check',
      description: 'Test VHF radio communication',
      completed: false,
      category: 'communication'
    },
    {
      id: 'comm2',
      title: 'AIS Transponder',
      description: 'Verify AIS is transmitting correctly',
      completed: false,
      category: 'communication'
    },
    {
      id: 'maint1',
      title: 'Engine Pre-Start Check',
      description: 'Oil, coolant, and fuel levels verified',
      completed: false,
      category: 'maintenance'
    },
    {
      id: 'maint2',
      title: 'Electrical Systems',
      description: 'Battery voltage and charging system check',
      completed: false,
      category: 'maintenance'
    },
    {
      id: 'dept1',
      title: 'Weather Conditions',
      description: 'Current and forecast weather acceptable',
      completed: false,
      category: 'departure'
    },
    {
      id: 'dept2',
      title: 'Port Clearance',
      description: 'Harbor control and departure clearance',
      completed: false,
      category: 'departure'
    }
  ]);

  protected getCategories(): string[] {
    const categories = new Set(this.checklistItems().map(item => item.category));
    return Array.from(categories);
  }

  protected getCategoryTitle(category: string): string {
    const titles = {
      navigation: 'Navigation Systems',
      safety: 'Safety Equipment',
      communication: 'Communication Systems',
      maintenance: 'Maintenance Checks',
      departure: 'Departure Procedures'
    };
    return titles[category] || category;
  }

  protected getItemsByCategory(category: string): ChecklistItem[] {
    return this.checklistItems().filter(item => item.category === category);
  }

  protected getCompletedCount(): number {
    return this.checklistItems().filter(item => item.completed).length;
  }

  protected getProgressPercentage(): number {
    const completed = this.getCompletedCount();
    const total = this.checklistItems().length;
    return total > 0 ? (completed / total) * 100 : 0;
  }

  protected toggleItem(item: ChecklistItem): void {
    this.checklistItems.update(items =>
      items.map(i => 
        i.id === item.id ? { ...i, completed: !i.completed } : i
      )
    );
  }

  protected resetChecklist(): void {
    this.checklistItems.update(items =>
      items.map(item => ({ ...item, completed: false }))
    );
  }

  protected completeAll(): void {
    this.checklistItems.update(items =>
      items.map(item => ({ ...item, completed: true }))
    );
  }

  protected handleClose(): void {
    this.closed.emit();
  }
}