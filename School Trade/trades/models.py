import uuid
from django.db import models
from django.conf import settings
from goods.models import Product

class Order(models.Model):
    """交易订单模型"""
    STATUS_CHOICES = (
        (0, '待确认'),
        (1, '已完成'),
        (2, '已取消'),
    )

    order_number = models.UUIDField(default=uuid.uuid4, editable=False, unique=True, verbose_name="订单编号")
    buyer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='orders', verbose_name="买家")
    product = models.OneToOneField(Product, on_delete=models.RESTRICT, related_name='order', verbose_name="交易商品")
    amount = models.DecimalField(max_digits=8, decimal_places=2, verbose_name="交易金额")
    status = models.SmallIntegerField(choices=STATUS_CHOICES, default=0, verbose_name="订单状态")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="下单时间")

    class Meta:
        verbose_name = "交易订单"
        verbose_name_plural = verbose_name
        db_table = "orders"
        ordering = ['-created_at']

    def __str__(self):
        return str(self.order_number)

class Comment(models.Model):
    """商品留言互动模型"""
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='comments', verbose_name="所属商品")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='comments', verbose_name="留言者")
    content = models.TextField(verbose_name="留言内容")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="留言时间")

    class Meta:
        verbose_name = "商品留言"
        verbose_name_plural = verbose_name
        db_table = "comments"
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.author.username} 的留言"