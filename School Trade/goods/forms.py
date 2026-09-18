from django import forms
from .models import Product


class ProductForm(forms.ModelForm):
    class Meta:
        model = Product
        # 定义前端表单需要用户填写的字段（seller 和 status 由后台自动生成，不让用户填）
        fields = ['title', 'category', 'price', 'condition', 'description', 'image']

        # 给前端输入框添加 Bootstrap 的 class 样式
        widgets = {
            'title': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '一句话介绍你的闲置'}),
            'category': forms.Select(attrs={'class': 'form-select'}),
            'price': forms.NumberInput(attrs={'class': 'form-control', 'min': '0'}),
            'condition': forms.Select(attrs={'class': 'form-select'}),
            'description': forms.Textarea(attrs={'class': 'form-control', 'rows': 4}),
            'image': forms.FileInput(attrs={'class': 'form-control'}),
        }

    # 表单验证：价格不能为负数
    def clean_price(self):
        price = self.cleaned_data.get('price')
        if price <= 0:
            raise forms.ValidationError("商品价格必须大于 0 哟！")
        return price