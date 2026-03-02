function calculateDiscount(price, discountPercent) {
    const discountRate = discountPercent / 100;
    return price * (1 - discountRate);
}
