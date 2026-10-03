import { randomUUID } from 'node:crypto';

import { safeEqual } from './security';

/** A short renewable idle-only lease protects callback repair from new calls. */
export class ConnectionMaintenance {
  private lease = '';

  private expires = 0;

  constructor(private now = Date.now) {}

  get active(): boolean {
    return Boolean(this.lease) && this.expires > this.now();
  }

  matches(value: unknown): boolean {
    return (
      this.active && typeof value === 'string' && safeEqual(value, this.lease)
    );
  }

  begin(busy: boolean): string {
    if (busy || this.active) throw new Error('CONNECTION_MAINTENANCE_BUSY');
    this.lease = randomUUID();
    this.expires = this.now() + 180000;
    return this.lease;
  }

  renew(value: unknown): void {
    if (!this.matches(value)) throw new Error('INVALID_MAINTENANCE_LEASE');
    this.expires = this.now() + 180000;
  }

  end(value: unknown): void {
    if (!this.matches(value)) throw new Error('INVALID_MAINTENANCE_LEASE');
    this.lease = '';
    this.expires = 0;
  }
}
