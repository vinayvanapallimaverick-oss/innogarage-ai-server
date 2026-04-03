import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { SubscriptionService } from '../subscription.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private subscriptionService: SubscriptionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.sub;

    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const sub = await this.subscriptionService.getSubscription(userId);

    if (!sub || sub.status !== 'active') {
      throw new ForbiddenException(
        'An active subscription is required to use interview features',
      );
    }

    return true;
  }
}
