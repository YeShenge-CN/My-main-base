from django.shortcuts import render, redirect
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.decorators import login_required  # 💡 确保引入拦截器
from django.contrib import messages
from .forms import StudentRegisterForm

# 💡 跨模块引入：引入 trades 模块的订单模型和 goods 模块的商品模型进行数据清洗
from trades.models import Order
from goods.models import Product


def user_login(request):
    """处理用户登录的视图"""
    if request.method == 'POST':
        # 使用 Django 内置的登录表单
        form = AuthenticationForm(request, data=request.POST)
        if form.is_valid():
            # 验证成功，获取用户对象
            user = form.get_user()
            login(request, user)
            messages.success(request, "登录成功！")
            return redirect('index')  # 登录成功跳转到首页
        else:
            messages.error(request, "用户名或密码错误，请重试。")
    else:
        form = AuthenticationForm()

    return render(request, 'users/login.html', {'form': form})


def register(request):
    """处理学生注册的视图"""
    if request.method == 'POST':
        form = StudentRegisterForm(request.POST)
        if form.is_valid():
            # 保存到数据库，创建新用户
            user = form.save()
            # 注册成功后，直接帮用户自动登录，提升体验
            login(request, user)
            messages.success(request, f"欢迎加入校园淘，{user.username}！")
            return redirect('index')  # 跳转到首页
        else:
            messages.error(request, "注册失败，请检查下方飘红的错误提示。")
    else:
        form = StudentRegisterForm()

    return render(request, 'users/register.html', {'form': form})


def user_logout(request):
    """处理退出登录的视图"""
    logout(request)
    messages.success(request, "您已成功退出登录。")
    # 💡 核心修改：将 'index' 改为 'login'，让系统重定向到登录页
    return redirect('login')


@login_required(login_url='/login/')
def profile(request):
    """✨ 新增：个人中心主页视图"""
    # 1. 查询我买到的宝贝：买家是当前登录用户
    my_buys = Order.objects.filter(buyer=request.user)

    # 2. 查询我卖出的订单：关联商品的卖家是当前登录用户
    my_sells = Order.objects.filter(product__seller=request.user)

    # 3. 查询我上架发布的商品历史记录
    my_products = Product.objects.filter(seller=request.user)

    # 4 查询我挂出的所有商品
    my_products = Product.objects.filter(seller=request.user).order_by('-created_at')

    context = {
        'my_buys': my_buys,
        'my_sells': my_sells,
        'my_products': my_products,
    }
    return render(request, 'users/profile.html', context)