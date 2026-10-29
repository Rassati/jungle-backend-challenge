import Decimal from 'decimal.js';
import { DomainError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// NUMERIC(20,2) permits 18 integer digits. Extra precision keeps arithmetic exact.
const ExactDecimal = Decimal.clone({ precision: 50 });
const MAX_AMOUNT = new ExactDecimal('999999999999999999.99');
const DECIMAL_INPUT = /^\d+(?:\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !DECIMAL_INPUT.test(props.amount)) {
      throw new DomainError('INVALID_AMOUNT', 'Amount must be a non-negative decimal string with at most two decimal places.');
    }
    // The challenge permits BRL-only inputs. The value object remains multi-currency.
    if (typeof props.currency !== 'string' || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new DomainError('INVALID_CURRENCY', 'Currency must be a three-letter uppercase code.');
    }
    return Money.exact(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static exact(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds NUMERIC(20,2) capacity.');
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.exact(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.exact(this.value.sub(other.value), this.currency);
  }

  negate(): Money {
    return Money.exact(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan(0); }
  isNegative(): boolean { return this.value.lessThan(0); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string { return this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money operations require matching currencies.');
    }
  }
}
