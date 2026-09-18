from django.db import models
from users.models import User # 根据你实际的用户模型路径调整
from django.conf import settings  # 💡 必须添加这一行！

class Category(models.Model):
    """商品分类模型"""
    name = models.CharField(max_length=50, unique=True, verbose_name="分类名称")
    description = models.TextField(blank=True, null=True, verbose_name="分类描述")

    class Meta:
        verbose_name = "商品分类"
        verbose_name_plural = verbose_name
        db_table = "categories"

    def __str__(self):
        return self.name


class Product(models.Model):
    """二手商品模型"""
    CONDITION_CHOICES = (
        ('new', '全新'),
        ('almost_new', '九成新'),
        ('good', '良好'),
        ('fair', '一般'),
    )

    STATUS_CHOICES = (
        (0, '待售'),
        (1, '交易中'),
        (2, '已售出'),
        (3, '已下架'),
    )

    seller = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='products',
                               verbose_name="卖家")
    category = models.ForeignKey(Category, on_delete=models.RESTRICT, related_name='products', verbose_name="所属分类")
    title = models.CharField(max_length=100, verbose_name="商品标题")
    description = models.TextField(verbose_name="详细描述")
    price = models.DecimalField(max_digits=8, decimal_places=2, verbose_name="价格")
    condition = models.CharField(max_length=20, choices=CONDITION_CHOICES, default='good', verbose_name="新旧程度")
    image = models.ImageField(upload_to='products/%Y/%m/', verbose_name="商品主图")
    status = models.SmallIntegerField(choices=STATUS_CHOICES, default=0, verbose_name="商品状态")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="发布时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        verbose_name = "二手商品"
        verbose_name_plural = verbose_name
        db_table = "products"
        ordering = ['-created_at']

    def __str__(self):
        return self.title
