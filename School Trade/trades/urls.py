from django.urls import path
from . import views

app_name = 'trades'

urlpatterns = [
    path('create/<int:product_id>/', views.create_order, name='create_order'),
    path('confirm/<int:order_id>/', views.confirm_receipt, name='confirm_receipt'),
    path('comment/<int:product_id>/', views.add_comment, name='add_comment'), # 新增留言路由
]