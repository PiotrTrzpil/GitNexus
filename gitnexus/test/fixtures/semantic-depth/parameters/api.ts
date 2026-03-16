interface RequestContext { userId: string; traceId: string; }

function handleRequest(
  ctx: RequestContext,
  path: string,
  method: string = 'GET',
  timeout?: number,
  ...middleware: Function[]
) { /* ... */ }

class PaymentService {
  constructor(
    private db: Database,
    private logger: Logger,
    protected cache?: Cache,
  ) {}

  charge(amount: number, currency: string) {
    this.db.query('...');
    this.logger.log('charged');
    // note: this.cache never used in this class
  }

  refund(amount: number) {
    this.db.query('...');
    this.logger.log('refunded');
  }
}
