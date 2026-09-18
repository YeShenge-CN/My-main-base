from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from goods.models import Product
from .models import Order, Comment


@login_required(login_url='/login/')
def create_order(request, product_id):
    """适配版：处理下单"""
    product = get_object_or_404(Product, id=product_id)

    # 1. 卖家就是发布者：product.seller
    if request.user == product.seller:
        messages.error(request, "不能购买自己发布的商品哦！")
        return redirect('product_detail', product_id=product.id)

    # 2. 检查商品是否还可以购买 (假设你的 Product 里 0 是待售)
    if product.status != 0:
        messages.error(request, "手慢无！该商品已被其他同学拍下。")
        return redirect('index')

    # 3. 创建交易订单（适配你的模型：包含 amount 交易金额，自动生成 UUID）
    Order.objects.create(
        product=product,
        buyer=request.user,
        amount=product.price  # 自动同步商品售价到交易金额
    )

    # 4. 变更商品状态为交易中/已售
    product.status = 1
    product.save()

    messages.success(request, "🎉 下单成功！快去个人中心查看并联系卖家吧。")
    return redirect('profile')


@login_required(login_url='/login/')
def confirm_receipt(request, order_id):
    """适配版：买家确认收货"""
    # 根据你的模型，通过 id 找到属于当前买家的订单
    order = get_object_or_404(Order, id=order_id, buyer=request.user)
    if order.status == 0:  # 0: 待确认
        order.status = 1  # 1: 已完成
        order.save()
        messages.success(request, "✅ 确认收货成功，交易圆满结束！")
    return redirect('profile')


@login_required(login_url='/login/')
def add_comment(request, product_id):
    """新增：处理商品详情页留言提交"""
    if request.method == "POST":
        product = get_object_or_404(Product, id=product_id)
        content = request.POST.get('content', '').strip()

        if not content:
            messages.error(request, "留言内容不能为空内容哦！")
        else:
            # 创建留言记录
            Comment.objects.create(
                product=product,
                author=request.user,
                content=content
            )
            messages.success(request, "✨ 留言成功，等待卖家回复！")

    return redirect('product_detail', product_id=product_id)

@login_required(login_url='/login/')
def confirm_receipt(request, order_id):
    """适配版：买家确认收货"""
    # 先只按 ID 查找，看看是否存在
    try:
        order = Order.objects.get(id=order_id)
        # 如果找到了，再检查买家身份
        if order.buyer != request.user:
            messages.error(request, "这不是您的订单，无法确认收货！")
            return redirect('profile')
    except Order.DoesNotExist:
        messages.error(request, f"找不到 ID 为 {order_id} 的订单，请检查数据库。")
        return redirect('profile')

    # 如果逻辑通过，执行收货
    if order.status == 0:
        order.status = 1
        order.save()
        messages.success(request, "✅ 确认收货成功！")
    return redirect('profile')