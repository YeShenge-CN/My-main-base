from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'), # 首页路由
    path('publish/', views.product_create, name='product_create'), # 发布闲置路由
    path('product/<int:product_id>/', views.product_detail, name='product_detail'),
    path('unshelve/<int:product_id>/', views.unshelve_product, name='unshelve_product'),
]