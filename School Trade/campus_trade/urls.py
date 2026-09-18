"""
URL configuration for campus_trade project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('goods.urls')),
    path('users/', include('users.urls')),

    # 💡 核心修复：在这里显式指定 namespace
    # 如果你的 trades/urls.py 里已经写了 app_name = 'trades'，这里其实可以不写，
    # 但如果报错，最稳妥的方法是这样写：
    path('trades/', include('trades.urls', namespace='trades')),
]

# 允许在开发环境下通过 URL 访问 media 文件夹里的图片
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
