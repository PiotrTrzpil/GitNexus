function handlePayment(user: User, amount: number) {
  validateInput(amount);                           // unconditional — branchDepth 0

  if (user.isAdmin) {
    applyDiscount(amount);                         // conditional — branchDepth 1, guard "if (user.isAdmin)"
    if (amount > 1000) {
      requireApproval(user);                       // conditional — branchDepth 2, guard "if (amount > 1000)"
    }
  }

  const result = processCharge(amount);            // unconditional — branchDepth 0

  try {
    sendReceipt(user);                             // unconditional (try is not conditional)
  } catch (e) {
    logError(e);                                   // conditional — branchDepth 1, guard "catch"
  }

  user.isPremium && notifyVIP(user);               // conditional — branchDepth 1, guard "user.isPremium && ..."
  user.referrer ?? sendWelcome(user);              // conditional — branchDepth 1, guard "user.referrer ?? ..."

  for (const hook of hooks) {
    hook.run();                                    // unconditional (loop is not conditional)
  }

  return result;
}
