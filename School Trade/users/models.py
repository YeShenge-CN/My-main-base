from django.db import models
from django.contrib.auth.models import AbstractUser

class User(AbstractUser):
    """扩展 Django 默认用户模型"""
    student_id = models.CharField(max_length=20, unique=True, verbose_name="学号")
    dorm_building = models.CharField(max_length=50, verbose_name="宿舍楼栋")
    phone = models.CharField(max_length=11, verbose_name="联系电话")

    class Meta:
        verbose_name = "用户"
        verbose_name_plural = verbose_name
        db_table = "users"

    def __str__(self):
        return f"{self.username} ({self.student_id})"