import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { CASH_SCALE, dec, fmtCash } from '../../domain/money.js';
import type { Clock } from '../../lib/clock.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import type { LedgerRepository } from '../ledger/ledger.repository.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AuthUser {
  id: string;
  email: string;
}

// Constant dummy hash so login timing does not reveal whether an email exists.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
    private readonly initialFunding: string,
  ) {}

  /**
   * Creates a user, its USD accounts and posts the initial FUNDING journal
   * (EXTERNAL_FUNDING -X, user available +X) in one transaction.
   */
  async register(
    emailRaw: string,
    password: string,
    funding: string = this.initialFunding,
  ): Promise<AuthUser> {
    const email = emailRaw.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const amount = dec(funding);
    if (amount.lt(0) || amount.decimalPlaces() > CASH_SCALE)
      throw new Error('invalid funding amount');
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: users.id, email: users.email });
      if (!user) throw new ConflictError('EMAIL_TAKEN', 'a user with this email already exists');
      await this.ledger.ensureUserAccounts(tx, user.id, null);
      if (amount.gt(0)) {
        const [available] = (await this.ledger.listUserAccounts(tx, user.id)).filter(
          (a) => a.assetId === null && a.type === 'USER_AVAILABLE',
        );
        const source = await this.ledger.getSystemAccount(tx, 'EXTERNAL_FUNDING', null);
        await this.ledger.postJournal(tx, {
          type: 'FUNDING',
          userId: user.id,
          description: `initial stablecoin funding ${fmtCash(amount)} USD`,
          createdAt: now,
          lines: [
            { account: source, amount: amount.neg() },
            { account: available!, amount },
          ],
        });
      }
      return user;
    });
  }

  async authenticate(emailRaw: string, password: string): Promise<AuthUser> {
    const email = emailRaw.trim().toLowerCase();
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedError('invalid email or password');
    return { id: user.id, email: user.email };
  }

  async findUser(id: string): Promise<AuthUser | null> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, id));
    return user ?? null;
  }
}
