from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from .models import Product, Category  # 确保导入 Category
from .forms import ProductForm


def index(request):
    """首页视图：增加分类筛选"""
    # 1. 获取所有分类
    categories = Category.objects.all()

    # 2. 获取请求中的分类 ID (如果用户点击了筛选)
    category_id = request.GET.get('category_id')

    # 3. 基础查询：只筛选待售商品
    products = Product.objects.filter(status=0)

    # 4. 如果有筛选条件，进一步过滤
    if category_id:
        products = products.filter(category_id=category_id)

    # 5. 按时间倒序排列
    products = products.order_by('-created_at')

    context = {
        'products': products,
        'categories': categories,
        'selected_category': category_id,
    }
    return render(request, 'goods/index.html', context)


def product_detail(request, product_id):
    """商品详情视图"""
    product = get_object_or_404(Product, id=product_id)
    return render(request, 'goods/product_detail.html', {'product': product})


@login_required(login_url='/login/')
def product_create(request):
    """发布商品视图"""
    if request.method == 'POST':
        form = ProductForm(request.POST, request.FILES)
        if form.is_valid():
            product = form.save(commit=False)
            product.seller = request.user
            product.save()
            messages.success(request, "发布成功！宝贝已上架。")
            return redirect('index')
        else:
            messages.error(request, "发布失败，请检查表单内容。")
    else:
        form = ProductForm()

    return render(request, 'goods/product_form.html', {'form': form})

@login_required
def unshelve_product(request, product_id):
    # 确保商品是当前用户发布的
    product = get_object_or_404(Product, id=product_id, seller=request.user)
    if product.status == 0:
        product.status = 2  # 假设 2 为下架状态
        product.save()
        messages.success(request, "商品已成功下架。")
    return redirect('profile') # 需确保你的 urls.py 中有 profile 别名